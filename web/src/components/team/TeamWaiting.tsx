// What the owner's phone asked and waits for the passkey on this computer (#377), at the top of
// the Team panel's list, above the agents' drafts: a send from the phone (or the domain) cannot open
// the confirmation window, which lives on localhost. Each says what it does as the window will
// (ConfirmScreen.tsx confirmLines), its first line and when it was asked, with Confirm, which opens
// the window on this click. The board forgets it after 2 minutes; the list follows.
import { useT } from '../../i18n/I18nProvider.tsx'
import type { Waiting } from '../../models/team.ts'
import { listWhen } from '../../models/team-chat.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { confirmLines } from './ConfirmScreen.tsx'

export interface TeamWaitingProps {
  waiting: readonly Waiting[]
  disabled: boolean
  onConfirm(id: string): void
}

export function TeamWaiting({ waiting, disabled, onConfirm }: TeamWaitingProps) {
  const t = useT()
  const { now } = useBoardContext()
  if (!waiting.length) return null
  return (
    <section className="team-scope team-drafts team-waiting">
      <h3>
        {t('team.waitingHead')} <span className="n team-unread">{waiting.length}</span>
      </h3>
      <p className="hint">{t('team.waitingAbout')}</p>
      {waiting.map(w => {
        const lines = confirmLines(w.action, t)
        const first = lines.text?.split(/\r?\n/).find(l => l.trim())
        return (
          <div key={w.id} className="team-draft team-draft-card" data-waiting={w.id}>
            <p className="team-draft-where">
              <span className="team-row-title">{lines.title}</span>
              <span className="team-row-when">{listWhen(new Date(w.at).toISOString(), t, now)}</span>
            </p>
            {first && <p className="team-draft-line">{first}</p>}
            {lines.items?.map(item => (
              <p key={item} className="team-draft-file">
                {item}
              </p>
            ))}
            <div className="team-draft-actions">
              <button
                type="button"
                className="mini primary"
                disabled={disabled}
                title={t('team.waitingConfirmHint')}
                onClick={() => onConfirm(w.id)}
              >
                {t('team.waitingConfirm')}
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
