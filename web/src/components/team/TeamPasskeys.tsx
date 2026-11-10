// The owner's passkeys for this board (#224), in the Team panel: Send, trust and turning agents on
// wait for one (src/core/team-confirm.ts). The list (GET /api/team/passkeys), Add and Remove; both
// are confirmed in the window on localhost (models/team-confirm.ts), Add of the first one on trust,
// every other with a passkey there is.
import { useEffect, useState } from 'react'
import { ApiError, api, errorText } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { confirmError, ownerPost } from '../../models/team-confirm.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

interface Passkey {
  id: string
  label: string
  addedAt: number
}
const isList = (v: unknown): v is { passkeys: Passkey[] } =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as { passkeys?: unknown }).passkeys) &&
  (v as { passkeys: unknown[] }).passkeys.every(
    p =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as Passkey).id === 'string' &&
      typeof (p as Passkey).label === 'string',
  )

export function TeamPasskeys({ open, disabled }: { open: boolean; disabled: boolean }) {
  const t = useT()
  const { toast } = useBoardContext()
  const [list, setList] = useState<Passkey[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    try {
      setList((await api.get('/api/team/passkeys', isList, { cache: 'no-store' })).passkeys)
    } catch {
      setList(null)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again each time the panel opens
  useEffect(() => {
    if (open) void load()
  }, [open])

  async function change(body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    try {
      await ownerPost('/api/team/passkeys', body)
    } catch (err) {
      const code = err instanceof ApiError ? err.reply.error : null
      if (code !== 'cancelled') toast(confirmError(err, t) ?? errorText(err, t), true)
    }
    setBusy(false)
    void load()
  }

  if (!list) return null
  return (
    <section className="team-passkeys">
      <h3>{t('team.passkeys')}</h3>
      <p className="hint">{list.length ? t('team.passkeys.about') : t('team.passkeys.none')}</p>
      {list.length > 0 && (
        <ul>
          {list.map(p => (
            <li key={p.id}>
              <span>{t('team.passkeys.item', { label: p.label, date: new Date(p.addedAt).toLocaleDateString() })}</span>
              <button
                type="button"
                className="mini"
                disabled={disabled || busy}
                onClick={() => void change({ op: 'remove', id: p.id })}
              >
                {t('team.passkeys.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="mini" disabled={disabled || busy} onClick={() => void change({ op: 'add' })}>
        {t('team.passkeys.add')}
      </button>
    </section>
  )
}
