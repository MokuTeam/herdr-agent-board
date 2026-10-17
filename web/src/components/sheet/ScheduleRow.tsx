// The session's reminders in its sheet: the first three — when (orange once due), the text, the
// on-time / when-free toggle and the two-click cancel — and a link to the rest in the schedule
// panel. What the buttons do is the schedule panel's (Task 26): they come in as props.
import type { ScheduleEntry } from '../../../../src/core/schedule-rules.ts'
import { capital, longWhen } from '../../../../src/core/when-format.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { classNames } from '../class-names.ts'
import { AlarmGlyph, BoltGlyph, HourglassGlyph, RepeatGlyph, TrashGlyph } from '../icons.tsx'

export interface ScheduleActions {
  /** The entry whose cancel button asks "Cancel?" (a second click within four seconds removes it). */
  armed?: string | null | undefined
  onCancel?: ((id: string, button: HTMLElement) => void) | undefined
  onMode?: ((id: string, button: HTMLElement) => void) | undefined
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
              className={classNames('when', e.next <= now && 'due')}
              title={e.cron ? `${t('sched.repeat')}: ${e.cron}` : t('sched.once')}
            >
              {e.cron ? <RepeatGlyph /> : <AlarmGlyph />}
              {capital(longWhen(e.next, t, now), t)}
            </span>
            <span className="text" title={e.text}>
              {e.text}
            </span>
            <ModeButton entry={e} disabled={disabled} onMode={onMode} />
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

interface EntryButton {
  entry: ScheduleEntry
  disabled: boolean
}

/** On time or when the session is free: an icon here, a pill in the panel. */
function ModeButton({ entry, disabled, onMode }: EntryButton & Pick<ScheduleActions, 'onMode'>) {
  const t = useT()
  const idle = !!entry.idle
  return (
    <button
      type="button"
      className={classNames('sched-mode', idle && 'idle', 'short')}
      data-sched-mode={entry.id}
      title={t(idle ? 'sched.mode.idleHint' : 'sched.mode.onTimeHint')}
      aria-label={t(idle ? 'sched.mode.idle' : 'sched.mode.onTime')}
      aria-pressed={!idle}
      disabled={disabled}
      onClick={e => onMode?.(entry.id, e.currentTarget)}
    >
      {idle ? <HourglassGlyph /> : <BoltGlyph />}
    </button>
  )
}

function CancelButton({
  entry,
  ask,
  disabled,
  onCancel,
}: EntryButton & { ask: boolean } & Pick<ScheduleActions, 'onCancel'>) {
  const t = useT()
  return (
    <button
      type="button"
      className="sched-x"
      data-confirm={ask ? '' : undefined}
      data-sched-cancel={entry.id}
      title={t('sched.cancel')}
      aria-label={t(ask ? 'sched.confirm' : 'sched.cancel')}
      disabled={disabled}
      onClick={e => onCancel?.(entry.id, e.currentTarget)}
    >
      <TrashGlyph />
      <span>{ask ? t('sched.confirm') : ''}</span>
    </button>
  )
}
