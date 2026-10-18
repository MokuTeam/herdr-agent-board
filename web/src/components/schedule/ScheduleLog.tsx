// What the scheduler sent, missed or dropped lately, newest first: a mark, when, the session and
// the text, and why it was late, missed or dropped.
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { entryText, type LogRecord, logView } from '../../models/schedule.ts'
import { CheckGlyph } from '../icons.tsx'

export interface ScheduleLogProps {
  records: LogRecord[]
  itemOf(key: string): Item | undefined
  now: number
}

export function ScheduleLog({ records, itemOf, now }: ScheduleLogProps) {
  const t = useT()
  return records.map((r, i) => {
    const view = logView(r, itemOf, now, t)
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no id of their own; they only come and go whole
      <div className={`log-row ${view.result}`} key={i}>
        <span className="log-icon" title={view.iconTitle}>
          {view.icon === 'check' ? <CheckGlyph /> : view.icon}
        </span>
        <span className="log-when">{view.when}</span>
        <span className="log-what">
          <b>{view.name}</b> {entryText(r, t)}
        </span>
        {view.note && <span className="log-note">{view.note}</span>}
      </div>
    )
  })
}
