import { useEffect, useState } from 'react'
import type { OwnerService } from '../../../../src/core/owner-services.ts'
import { api, errorText, isReply } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ownerPost } from '../../models/team-confirm.ts'

const path = '/api/owner-services'
interface View {
  services: OwnerService[]
  hasPasskey: boolean
}
const isView = (value: unknown): value is View =>
  isReply(value) &&
  typeof value.hasPasskey === 'boolean' &&
  Array.isArray(value.services) &&
  value.services.every(s => isReply(s) && typeof s.key === 'string' && typeof s.name === 'string')

export function OwnerServices() {
  const t = useT()
  const [view, setView] = useState<View | null>(null)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void api.get(path, isView, { signal: controller.signal }).then(setView, err => {
      if (!controller.signal.aborted) setError(errorText(err, t))
    })
    return () => controller.abort()
  }, [t])

  const submit = async (action: { op: 'passkey' | 'add' | 'revoke'; name?: string; key?: string }) => {
    setBusy(true)
    setError('')
    setToken('')
    try {
      const result = await ownerPost(path, action)
      if (typeof result.token === 'string') {
        setToken(result.token)
        setName('')
      }
      setView(await api.get(path, isView))
    } catch (err) {
      setError(errorText(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="set-group">
      {view?.services.map(service => (
        <div key={service.key} className="set-row">
          <span>{service.name}</span>
          <button type="button" disabled={busy} onClick={() => void submit({ op: 'revoke', key: service.key })}>
            {t('ownerServices.revoke')}
          </button>
        </div>
      ))}
      {view?.hasPasskey ? (
        <form
          className="set-row"
          onSubmit={event => {
            event.preventDefault()
            void submit({ op: 'add', name })
          }}
        >
          <input
            aria-label={t('ownerServices.name')}
            placeholder={t('ownerServices.name')}
            value={name}
            onChange={event => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {t('ownerServices.add')}
          </button>
        </form>
      ) : (
        view && (
          <div className="set-row">
            <span>{t('ownerServices.passkeyNeeded')}</span>
            <button type="button" disabled={busy} onClick={() => void submit({ op: 'passkey' })}>
              {t('ownerServices.passkey')}
            </button>
          </div>
        )
      )}
      {token && (
        <label className="set-row">
          {t('ownerServices.token')}
          <input readOnly value={token} onFocus={event => event.target.select()} />
        </label>
      )}
      {error && (
        <p className="set-row" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
