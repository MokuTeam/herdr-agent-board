// The agents' drafts that wait for the owner (#415), at the top of the Team panel's list: every
// thread's at once, so one in a thread nobody opens is not missed. Each says where it would go and
// when the agent wrote it (two drafts of one file are told apart by that), its first line, its file
// with the size, who wrote it and why the board held it, with Discard and Send; its head opens the
// thread it waits in.
import { useT } from '../../i18n/I18nProvider.tsx'
import { type DraftLine, draftWhere, draftWhy, type TeamView, type ThreadView } from '../../models/team.ts'
import { listWhen } from '../../models/team-chat.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { fileSize } from './TeamFile.tsx'

export interface TeamDraftsProps {
  drafts: readonly DraftLine[]
  threads: readonly ThreadView[]
  view: TeamView
  disabled: boolean
  onSelect(key: string): void
  onSend(id: string): void
  onDiscard(id: string): void
}

export function TeamDrafts({ drafts, threads, view, disabled, onSelect, onSend, onDiscard }: TeamDraftsProps) {
  const t = useT()
  const { now } = useBoardContext()
  if (!drafts.length) return null
  return (
    <section className="team-scope team-drafts">
      <h3>
        {t('team.draftsHead')} <span className="n team-unread">{drafts.length}</span>
      </h3>
      {drafts.map(d => {
        const scope = d.key.slice(0, d.key.indexOf('/'))
        // Nothing goes to a key that changed until it is trusted: Send waits, as in the thread.
        const changed = view.roster.find(p => p.peer === scope)?.pin === 'changed'
        const first = d.text.split(/\r?\n/).find(l => l.trim())
        return (
          <div key={d.id} className="team-draft team-draft-card" data-draft={d.id}>
            <button
              type="button"
              className="team-draft-where"
              title={t('team.draftOpen')}
              onClick={() => onSelect(d.key)}
            >
              <span className="team-row-title">{draftWhere(d, threads, view, t)}</span>
              <span className="team-row-when">{listWhen(d.ts, t, now)}</span>
            </button>
            {first && <p className="team-draft-line">{first}</p>}
            {d.file && (
              <p className="team-draft-file">
                <span>{d.file.name}</span> · {fileSize(d.file.size)}
              </p>
            )}
            {(d.agent || d.reason) && (
              <p className="team-agent-mark">
                {d.agent && <code>{d.agent}</code>}
                {d.reason && <span>{draftWhy(d.reason, t)}</span>}
              </p>
            )}
            <div className="team-draft-actions">
              <button type="button" className="mini" disabled={disabled} onClick={() => onDiscard(d.id)}>
                {t('team.discard')}
              </button>
              <button
                type="button"
                className="mini primary"
                disabled={disabled || changed}
                title={t('team.draftSendHint')}
                onClick={() => onSend(d.id)}
              >
                {t('team.send')}
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
