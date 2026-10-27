// The session's reminders in its sheet: the next one by default — when (orange once due), the
// text, the on-time / when-free toggle and the two-click cancel — with a count that opens the
// rest in place (three, then a link to the schedule panel). What the buttons do is the page's
// schedule desk (hooks/useSchedule.ts), shared with the schedule panel: they come in as props.
import { useState } from 'react'
import type { ScheduleEntry } from '../../../../src/core/schedule-rules.ts'
import { capital, longWhen } from '../../../../src/core/when-format.ts'
import type { ScheduleShown } from '../../hooks/useSchedule.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { restartView } from '../../models/restart.ts'
import { entryText, overdue } from '../../models/schedule.ts'
import type { Held } from '../../models/schedule-desk.ts'
import { classNames } from '../class-names.ts'
import { AlarmGlyph, RepeatGlyph, RestartGlyph, Turn } from '../icons.tsx'
import { CancelButton, ModeButton } from '../schedule/ScheduleButtons.tsx'

export interface ScheduleActions {
  /** The entry whose cancel button asks "Cancel?" (a second click within four seconds removes it). */
  armed?: string | null | undefined
  /** While a cancelled entry's rows fold away: what the row keeps showing until they are gone. */
  held?: Held<ScheduleShown> | null | undefined
  onCancel?: ((id: string) => void) | undefined
  onMode?: ((id: string) => void) | undefined
  /** "+2 more": the schedule panel, at this session's entries. */
  onMore?: (() => void) | undefined
}

export interface ScheduleRowProps extends Omit<ScheduleActions, 'held'> {
  /** The session's entries, soonest first (the server sorts them). */
  entries: ScheduleEntry[]
  now: number
  disabled: boolean
  /** A cancelled entry is folding: keep the rows it had, not the compact one. */
  forceExpanded?: boolean
}

const SHOWN = 3

export function ScheduleRow({
  entries,
  now,
  disabled,
  armed,
  onCancel,
  onMode,
  onMore,
  forceExpanded = false,
}: ScheduleRowProps) {
  const t = useT()
  // One entry by default; the count opens the rest in place, so a session with several
  // reminders costs one line until it is asked for. While one is being cancelled, the rows
  // it had stay, so the question is asked on the row it belongs to.
  const [expanded, setExpanded] = useState(false)
  if (!entries.length) return null
  const open = expanded || forceExpanded || !!armed
  const shown = open ? entries.slice(0, SHOWN) : entries.slice(0, 1)
  return (
    <div className="row sched-row">
      <span className="row-label">{t('sched.row')}</span>
      <div className="row-value">
        {shown.map(e =>
          e.kind === 'restart' ? (
            <RestartRow key={e.id} entry={e} disabled={disabled} ask={armed === e.id} onCancel={onCancel} />
          ) : (
            <div className="sched-mini" data-id={e.id} key={e.id}>
              <span
                className={classNames('when', overdue(e, now) && 'due')}
                title={e.cron ? `${t('sched.repeat')}: ${e.cron}` : t('sched.once')}
              >
                {e.cron ? <RepeatGlyph /> : <AlarmGlyph />}
                {capital(longWhen(e.next, t, now), t)}
              </span>
              <span className="text" title={entryText(e, t)}>
                {entryText(e, t)}
              </span>
              <ModeButton entry={e} short disabled={disabled} onMode={onMode} />
              <CancelButton entry={e} ask={armed === e.id} disabled={disabled} onCancel={onCancel} />
            </div>
          ),
        )}
        {entries.length > 1 && !forceExpanded && !armed && (
          <button
            type="button"
            className="sched-more"
            data-sched-toggle=""
            onClick={() => setExpanded(shown => !shown)}
          >
            {expanded ? t('sched.collapse') : t('sched.count', { n: entries.length })}
          </button>
        )}
        {open && entries.length > SHOWN && (
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

/** A restart has no time of its own: it goes once the session is free, and says how it stands. */
function RestartRow({
  entry,
  disabled,
  ask,
  onCancel,
}: {
  entry: ScheduleEntry
  disabled: boolean
  ask: boolean
  onCancel?: ((id: string) => void) | undefined
}) {
  const t = useT()
  const view = restartView(entry, t)
  return (
    <div className="sched-mini restart" data-id={entry.id}>
      <span className={classNames('when', view.on && 'on')} title={view.title}>
        <Turn>
          <RestartGlyph />
        </Turn>
        {view.badge}
      </span>
      <span className="text" title={view.title}>
        {entry.text || view.title}
      </span>
      <CancelButton entry={entry} ask={ask} disabled={disabled} onCancel={onCancel} />
    </div>
  )
}
