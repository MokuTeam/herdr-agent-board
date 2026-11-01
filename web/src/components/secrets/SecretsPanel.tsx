// Settings → Secrets…, a panel built like Remote access's parts (components/access): the owner's
// secrets for the agents (src/core/secret-store.ts), offered on the local board's page and on the
// board's own server (models/settings-menu.ts offersSecrets). At the top how agents get them, when
// a change applies and what the scopes do not guard against. Then a row per secret: its name,
// where it applies, when it was set and when a session last got it, Replace (the form filled with
// its name and place) and Delete (two clicks, as the logins' End). Then the form: the name, where
// it applies (everywhere, a profile, a Claude session), the value in a password field that is
// never filled in and is emptied as soon as the board answered. The list and the changes are
// hooks/useSecrets.ts's.

import type { Ref } from 'react'
import { useEffect, useRef } from 'react'
import type { SecretMeta, SecretScope } from '../../../../src/core/secret-store.ts'
import { type SecretsActions, type SecretsNow, useSecrets } from '../../hooks/useSecrets.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type Choice,
  nameError,
  profileChoices,
  replaced,
  scopeLabel,
  sessionChoices,
  setBody,
  setLine,
  usedLine,
  valueError,
} from '../../models/secrets.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { TwoClicks } from '../access/LoginSection.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface SecretsPanelProps {
  open: boolean
  onClose(): void
}

export function SecretsPanel({ open, onClose }: SecretsPanelProps) {
  const t = useT()
  const { now, source } = useSecrets(open)
  const value = useRef<HTMLInputElement>(null)
  // Replace asked for the value field: it is the one thing left to type.
  useEffect(() => {
    if (now.focus) value.current?.focus()
  }, [now.focus])
  return (
    <Panel
      id="secrets-sheet"
      kind="secrets"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('secrets.title')}</h2>
          <p className="sheet-meta">{t('secrets.about')}</p>
        </>
      }
    >
      <SecretsBody now={now} act={source} valueRef={value} />
    </Panel>
  )
}

export interface SecretsBodyProps {
  now: SecretsNow
  act: SecretsActions
  /** The value field, for Replace's focus. */
  valueRef?: Ref<HTMLInputElement>
}

const SCOPES: readonly SecretScope[] = ['global', 'profile', 'session']

/** The panel's body for a state (what the tests draw): the help, the list, the form. */
export function SecretsBody({ now, act, valueRef }: SecretsBodyProps) {
  const t = useT()
  const { data, canEdit } = useBoardContext()
  const off = !canEdit || now.busy
  const items = data?.items ?? []
  const { view, form } = now
  const nameWrong = nameError(form.name, t)
  const valueWrong = valueError(form.value, t)
  const replacing = view ? replaced(form, view.secrets) : undefined
  const ready = !!setBody(form, items)
  const choices: Choice[] =
    form.scope === 'profile'
      ? profileChoices(data?.profiles, t, form.target)
      : form.scope === 'session'
        ? sessionChoices(
            items,
            t,
            form.target ? { id: form.target, ...(form.targetName && { name: form.targetName }) } : undefined,
          )
        : []
  return (
    <div className="sheet-body cats-body access-body secrets-body">
      <div className="secrets-help">
        <p className="sheet-meta">{t('secrets.how')}</p>
        <p className="access-line secrets-command">
          <code className="access-code">board secret get NAME</code> {t('secrets.get')}
        </p>
        <p className="access-line secrets-command">
          <code className="access-code">board secret file NAME</code> {t('secrets.file')}
        </p>
        <p className="sheet-meta">{t('secrets.asked')}</p>
        <p className="sheet-meta">{t('secrets.order')}</p>
        <p className="sheet-meta">{t('secrets.when')}</p>
        <p className="sheet-meta">{t('secrets.limit')}</p>
      </div>

      <h3 className="access-head">{t('secrets.list')}</h3>
      {!view || view.secrets.length === 0 ? (
        <p className="sheet-meta access-none">{t(view ? 'secrets.none' : 'secrets.loading')}</p>
      ) : (
        <ul className="access-rows secrets-rows">
          {view.secrets.map(s => (
            <SecretRow key={s.id} secret={s} armed={now.sure === s.id} disabled={off} act={act} />
          ))}
        </ul>
      )}

      <h3 className="access-head">{t('secrets.add')}</h3>
      <form
        className="access-form secrets-form"
        onSubmit={e => {
          e.preventDefault()
          if (!off && ready) void act.save()
        }}
      >
        <div className="access-fields">
          <label className="access-field">
            <span>{t('secrets.name')}</span>
            <input
              className="path-add access-input secrets-name-field"
              name="secret-name"
              placeholder="GITHUB_TOKEN"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={form.name}
              disabled={off}
              onChange={e => act.edit({ name: e.currentTarget.value })}
            />
          </label>
          {nameWrong && <p className="access-problem">{nameWrong}</p>}
          <div className="access-field">
            <span>{t('secrets.for')}</span>
            <div className="profile-shown">
              {SCOPES.map(scope => (
                <button
                  type="button"
                  key={scope}
                  aria-pressed={form.scope === scope}
                  disabled={off}
                  onClick={() => act.edit({ scope })}
                >
                  {t(`secrets.pick.${scope}`)}
                </button>
              ))}
            </div>
          </div>
          {form.scope !== 'global' && (
            <div className="access-field">
              <span>{t(form.scope === 'profile' ? 'secrets.profile' : 'secrets.session')}</span>
              {/* A quiet select, as a lane's usual profile in the categories panel. */}
              <label className="cat-profile">
                <select
                  name={form.scope === 'profile' ? 'secret-profile' : 'secret-session'}
                  aria-label={t(form.scope === 'profile' ? 'secrets.profile' : 'secrets.session')}
                  value={form.target ?? ''}
                  disabled={off || choices.length === 0}
                  onChange={e => act.edit({ target: e.currentTarget.value || null })}
                >
                  <option value="">
                    {t(
                      form.scope === 'profile'
                        ? 'secrets.pickProfile'
                        : choices.length
                          ? 'secrets.pickSession'
                          : 'secrets.noSessions',
                    )}
                  </option>
                  {choices.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <label className="access-field">
            <span>{t('secrets.value')}</span>
            <input
              ref={valueRef}
              className="path-add access-input secrets-value"
              type="password"
              name="secret-value"
              aria-label={t('secrets.value')}
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              // Password managers: nothing to offer or save here.
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              value={form.value}
              disabled={off}
              onChange={e => act.edit({ value: e.currentTarget.value })}
            />
          </label>
          {valueWrong && <p className="access-problem">{valueWrong}</p>}
        </div>
        <p className="access-tip">{t('secrets.valueTip')}</p>
        <div className="access-actions">
          <button type="submit" className="button primary" disabled={off || !ready}>
            {t(replacing ? 'secrets.saveReplace' : 'secrets.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

interface SecretRowProps {
  secret: SecretMeta
  armed: boolean
  disabled: boolean
  act: SecretsActions
}

/** A secret: its name over where it applies and when it was set and used; Replace and Delete. */
function SecretRow({ secret: s, armed, disabled, act }: SecretRowProps) {
  const t = useT()
  const { data, now } = useBoardContext()
  const items = data?.items ?? []
  return (
    <li className="access-row secrets-row" data-id={s.id}>
      <div className="access-about">
        <strong className="access-label secrets-name">{s.name}</strong>
        <span className="access-meta">{scopeLabel(s, data?.profiles, items, t)}</span>
        <span className="access-meta">
          {setLine(s, t, now)} · {usedLine(s, items, t, now)}
        </span>
      </div>
      <div className="secrets-acts">
        <button type="button" className="button" disabled={disabled} onClick={() => act.replace(s)}>
          {t('secrets.replace')}
        </button>
        <TwoClicks
          armed={armed}
          label={t('secrets.delete')}
          sure={t('secrets.deleteSure')}
          disabled={disabled}
          onArm={() => act.arm(s.id)}
          onDisarm={() => act.arm(null)}
          onSure={() => void act.remove(s)}
        />
      </div>
    </li>
  )
}
