// One entry of the schedule panel: its time (orange while it waits for its session), once or
// repeating, the session it is for (a click opens it), its text, the delivery pill, the repeat
// rule and counts, why it waits, and the two-click cancel.
import { Fragment, type ReactNode } from 'react'
import type { ScheduleEntry as Entry } from '../../../../src/core/schedule-rules.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { EntryView } from '../../models/schedule.ts'
import { classNames } from '../class-names.ts'
import { RepeatGlyph } from '../icons.tsx'
import { CancelButton, ModeButton } from './ScheduleButtons.tsx'

export interface ScheduleEntryProps {
  entry: Entry
  view: EntryView
  /** As the group words it. */
  time: string
  /** The cancel button asks "Cancel?". */
  ask: boolean
  /** The buttons do nothing now (the board is not connected). */
  disabled: boolean
  onCancel?: ((id: string) => void) | undefined
  onMode?: ((id: string) => void) | undefined
  onOpen?: ((key: string) => void) | undefined
}

export function ScheduleEntry({ entry, view, time, ask, disabled, onCancel, onMode, onOpen }: ScheduleEntryProps) {
  const t = useT()
  const parts: { key: string; node: ReactNode }[] = [
    ...(view.cron ? [{ key: 'cron', node: <code>{view.cron}</code> }] : []),
    ...view.stats.map(text => ({ key: text, node: text })),
  ]
  return (
    <div className={classNames('sched-entry', view.waiting && 'waiting')} data-id={entry.id} data-key={entry.key}>
      <div className="sched-time">
        <b>{time}</b>
        <span>
          {view.repeats ? (
            <>
              <RepeatGlyph />
              {t('sched.repeat')}
            </>
          ) : (
            t('sched.once')
          )}
        </span>
      </div>
      <div className="sched-main">
        <button
          type="button"
          className="sched-who"
          data-open={entry.key}
          style={{ '--lane': view.who.color }}
          title={view.who.onBoard ? t('sched.open') : undefined}
          disabled={!view.who.onBoard}
          onClick={() => onOpen?.(entry.key)}
        >
          {view.who.name}
        </button>
        <div className="sched-text">{entry.text}</div>
        <div className="sched-stats">
          <ModeButton entry={entry} disabled={disabled} onMode={onMode} />
          {parts.length > 0 && (
            <span>
              {parts.map((part, i) => (
                <Fragment key={part.key}>
                  {i > 0 && ' · '}
                  {part.node}
                </Fragment>
              ))}
            </span>
          )}
        </div>
        {view.note && <div className={classNames('sched-state', view.noteMuted && 'muted')}>{view.note}</div>}
      </div>
      <CancelButton entry={entry} ask={ask} disabled={disabled} onCancel={onCancel} />
    </div>
  )
}
