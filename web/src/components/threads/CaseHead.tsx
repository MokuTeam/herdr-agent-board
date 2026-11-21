// A case's head in the thread pane (#488, case files): its outside reference, where it stands (the
// state, with its date and author) and the sessions that worked on it, each with where the board
// sees it now. Read only: an agent writes them with board thread. Nothing renders for a thread that
// is no case and has no sessions, and the route sends no `case` while case files are off.
import { useEffect } from 'react'
import { type CaseSessionView, shortKey } from '../../../../src/core/work-cases.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { partyLabel, type ThreadRow } from '../../models/work-threads.ts'
import { WhoChip } from './bits.tsx'

/** The case files' sheet (web/styles/cases.css), linked the first time a case is shown, before the Terminal look's. */
export function linkCasesSheet(doc: Document = document): void {
  if (doc.getElementById('cases-css')) return
  const link = doc.createElement('link')
  link.id = 'cases-css'
  link.rel = 'stylesheet'
  link.href = 'styles/cases.css'
  const look = doc.querySelector('link[href$="look-terminal.css"]')
  if (look?.parentNode) look.parentNode.insertBefore(link, look)
  else doc.head.append(link)
}

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function CaseHead({ head, sessions }: { head: ThreadRow; sessions: readonly CaseSessionView[] | undefined }) {
  const t = useT()
  const shown = !!sessions && (!!head.ref || !!head.state || sessions.length > 0)
  // The sheet once a case is shown, after the render as the threads' own sheet is linked.
  useEffect(() => {
    if (shown) linkCasesSheet()
  }, [shown])
  if (!sessions || !shown) return null
  // The author by the name the board knows for that session now (an archived one's record keeps it).
  const stateBy = (p: NonNullable<ThreadRow['state']>['by']): string =>
    (p.kind === 'session' && sessions.find(s => s.key === p.key)?.name) || partyLabel(p, t('wt.you'))
  return (
    <section className="wt-case" aria-label={t('wt.case.title')}>
      {head.ref && (
        <p className="wt-case-ref">
          <span className="wt-case-label">{t('wt.case.ref')}</span>
          {/^https?:\/\//i.test(head.ref) ? (
            <a className="ext" href={head.ref} target="_blank" rel="noopener noreferrer">
              {head.ref}
            </a>
          ) : (
            <code>{head.ref}</code>
          )}
        </p>
      )}
      {head.state && (
        <div className="wt-case-state">
          <span className="wt-case-label">
            {t('wt.case.state')} · {when(head.state.at)} · {stateBy(head.state.by)}
          </span>
          <p>{head.state.text}</p>
        </div>
      )}
      {sessions.length > 0 && (
        <div className="wt-case-sessions">
          <span className="wt-case-label">{t('wt.case.sessions')}</span>
          <ul>
            {sessions.map(s => (
              <li key={s.key} data-state={s.state}>
                <WhoChip party={{ kind: 'session', key: s.key, name: s.name || s.key.slice(0, 8) }} />
                <code title={s.key}>{shortKey(s.key)}</code>
                <span className="wt-case-live">
                  {!s.device
                    ? t(`wt.case.live.${s.state}`)
                    : s.state === 'unknown'
                      ? t('wt.case.onDevice', { device: s.device })
                      : s.seenAt !== undefined
                        ? t('wt.case.lastSeen', {
                            state: t(`wt.case.live.${s.state}`),
                            device: s.device,
                            when: when(s.seenAt),
                          })
                        : t('wt.case.liveOn', { state: t(`wt.case.live.${s.state}`), device: s.device })}
                </span>
                {s.holds && <span className="wt-case-holds">{t('wt.case.holds')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
