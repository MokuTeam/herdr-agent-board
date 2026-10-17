// The session's reminders in its sheet: the first three — when (orange once due), the text, the
// on-time / when-free toggle and the two-click cancel — and a link to the rest in the schedule
// panel. What the buttons do is the page's schedule desk (hooks/useSchedule.ts), shared with the
// schedule panel: they come in as props.
import type { ScheduleEntry } from '../../../../src/core/schedule-rules.ts'
import { capital, longWhen } from '../../../../src/core/when-format.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { overdue } from '../../models/schedule.ts'
import { classNames } from '../class-names.ts'
import { AlarmGlyph, RepeatGlyph } from '../icons.tsx'
import { CancelButton, ModeButton } from '../schedule/ScheduleButtons.tsx'

export interface ScheduleActions {
  /** The entry whose cancel button asks "Cancel?" (a second click within four seconds removes it). */
  armed?: string | null | undefined
  onCancel?: ((id: string) => void) | undefined
  onMode?: ((id: string) => void) | undefined
  /** "+2 more": the schedule panel, at this session's entries. */
  onMore?: (() => void) | undefined
}

export interface ScheduleRowProps extends ScheduleActions {
  /** The session's entries, soonest first (the server sorts them). */
  entries: ScheduleEntry[]
  now: number
  disabled: boolean
}

const SHOWN = 3

export function ScheduleRow({ entries, now, disabled, armed, onCancel, onMode, onMore }: ScheduleRowProps) {
  const t = useT()
  if (!entries.length) return null
  return (
    <div className="row sched-row">
      <span className="row-label">{t('sched.row')}</span>
      <div className="row-value">
        {entries.slice(0, SHOWN).map(e => (
          <div className="sched-mini" data-id={e.id} key={e.id}>
            <span
              className={classNames('when', overdue(e, now) && 'due')}
              title={e.cron ? `${t('sched.repeat')}: ${e.cron}` : t('sched.once')}
            >
              {e.cron ? <RepeatGlyph /> : <AlarmGlyph />}
              {capital(longWhen(e.next, t, now), t)}
            </span>
            <span className="text" title={e.text}>
              {e.text}
            </span>
            <ModeButton entry={e} short disabled={disabled} onMode={onMode} />
            <CancelButton entry={e} ask={armed === e.id} disabled={disabled} onCancel={onCancel} />
          </div>
        ))}
        {entries.length > SHOWN && (
          <button
            type="button"
            className="sched-more"
            data-sched-more=""
            disabled={disabled}
            onClick={() => onMore?.()}
          >
            {t('sched.more', { n: entries.length - SHOWN })}
          </button>
        )}
      </div>
    </div>
  )
}
