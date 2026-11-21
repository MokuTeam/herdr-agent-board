// The "While you were away" strip (#489) under the toolbar: what changed on the board while the
// owner was away, in the order core/journal.ts gives (waits on you, stopped on an error, finished,
// waits on someone else, then counts), each row opening its card. Shown after a return until it is
// dismissed, and again from the toolbar's "Since 23:56" (hooks/useJournal.ts). Styles: journal.css.
import { clockText, journalEntries, noteText } from '../../../../src/core/journal.ts'
import type { JournalView } from '../../hooks/useJournal.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'

export function AwayStrip({ journal }: { journal: JournalView }) {
  const t = useT()
  const { data, now } = useBoardContext()
  const shown = journal.shown
  if (!shown) return null
  const laneTitle = (id: string): string => data?.categories.find(c => c.id === id)?.title ?? id
  const entries = journalEntries(shown.list)
  return (
    <section className="away-strip" id="away-strip" aria-label={shown.title}>
      <div className="away-head">
        <h2 className="away-title">{shown.title}</h2>
        <button
          type="button"
          className="away-close"
          title={t('journal.dismiss')}
          aria-label={t('journal.dismiss')}
          onClick={journal.close}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5.5 5.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
      {shown.list.recordedFrom !== undefined && (
        <p className="away-note">{t('journal.recordedFrom', { when: clockText(shown.list.recordedFrom, now) })}</p>
      )}
      {entries.length === 0 ? (
        <p className="away-note">{t('journal.nothing')}</p>
      ) : (
        <ul className="away-list">
          {entries.map(e => {
            if (!('row' in e))
              return (
                <li key={`note-${e.note}`} className="away-note">
                  {noteText(e, t)}
                </li>
              )
            const { row } = e
            const here = journal.onBoard(row.key)
            return (
              <li key={row.key} className={`away-row away-${row.kind}`}>
                <button
                  type="button"
                  className="away-open"
                  aria-disabled={!here}
                  title={here ? t('journal.open') : t('journal.gone')}
                  onClick={() => journal.open(row.key)}
                >
                  <span className="away-kind">{t(`journal.kind.${row.kind}`)}</span>
                  <span className="away-name">{row.name}</span>
                  <span className="away-lane">{laneTitle(row.lane)}</span>
                  {row.line && <span className="away-line">{row.line}</span>}
                  <time className="away-time" dateTime={new Date(row.at).toISOString()}>
                    {clockText(row.at, now)}
                  </time>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
