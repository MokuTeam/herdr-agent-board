// The Remote access panel's Active logins part: each browser signed in through the domain (its
// label, how it signed in, when, when it was last active, from where), ended one by one or all at
// once, two clicks each; then the recent failed sign-ins with why, in words. An ended login stops
// at once: its next request is refused and its open streams end.
import { useT } from '../../i18n/I18nProvider.tsx'
import { attemptLine, loginLine } from '../../models/access.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { type LoginPartProps, TwoClicks } from './LoginSection.tsx'

export function LoginsSection({ view, send, ask, onAsk }: LoginPartProps) {
  const t = useT()
  const { canEdit, now } = useBoardContext()
  const { logins, attempts } = view
  return (
    <section className="access-logins">
      <h3 className="access-head">{t('access.logins')}</h3>
      {logins.length === 0 ? (
        <p className="sheet-meta access-none">{t('access.loginsNone')}</p>
      ) : (
        <>
          <ul className="access-rows">
            {logins.map(l => (
              <li className="access-row" key={l.id}>
                <div className="access-about">
                  <strong className="access-label">{l.label}</strong>
                  <span className="access-meta">{loginLine(l, t, now)}</span>
                </div>
                <TwoClicks
                  armed={ask?.kind === 'login' && ask.id === l.id}
                  label={t('access.end')}
                  sure={t('access.endSure')}
                  disabled={!canEdit}
                  onArm={() => onAsk({ kind: 'login', id: l.id })}
                  onDisarm={() => onAsk(null)}
                  onSure={() => void send('login-end', { id: l.id })}
                />
              </li>
            ))}
          </ul>
          <div className="access-actions">
            <TwoClicks
              armed={ask?.kind === 'logins'}
              label={t('access.endAll')}
              sure={t('access.endAllSure')}
              disabled={!canEdit}
              onArm={() => onAsk({ kind: 'logins' })}
              onDisarm={() => onAsk(null)}
              onSure={() => void send('logins-end-all')}
            />
          </div>
        </>
      )}

      <h3 className="access-head">{t('access.attempts')}</h3>
      {attempts.length === 0 ? (
        <p className="sheet-meta access-none">{t('access.attemptsNone')}</p>
      ) : (
        <ul className="access-attempts">
          {attempts.map((a, i) => (
            // Two may share a moment and all the rest: the board's order tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: a failed attempt has no id
            <li className="access-attempt" key={`${a.at}-${i}`}>
              {attemptLine(a, t, now)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
