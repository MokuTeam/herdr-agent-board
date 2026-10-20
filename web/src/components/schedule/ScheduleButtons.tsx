// A reminder's two buttons, in the schedule panel and in the session's sheet: on time or when the
// session is free (a pill in the panel, an icon in the sheet), and cancel, which asks "Cancel?"
// first. What they do is the page's schedule desk (hooks/useSchedule.ts).
import type { ScheduleEntry } from '../../../../src/core/schedule-rules.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { classNames } from '../class-names.ts'
import { BoltGlyph, HourglassGlyph, TrashGlyph } from '../icons.tsx'

interface EntryButton {
  entry: ScheduleEntry
  disabled: boolean
}

export interface ModeButtonProps extends EntryButton {
  /** The sheet's: an icon alone. */
  short?: boolean
  onMode?: ((id: string) => void) | undefined
}

export function ModeButton({ entry, disabled, short = false, onMode }: ModeButtonProps) {
  const t = useT()
  // A restart, and a sleep, always wait until the session is free.
  if (entry.kind === 'restart' || entry.kind === 'sleep') return null
  const idle = !!entry.idle
  const label = t(idle ? 'sched.mode.idle' : 'sched.mode.onTime')
  return (
    <button
      type="button"
      className={classNames('sched-mode', idle && 'idle', short && 'short')}
      data-sched-mode={entry.id}
      title={t(idle ? 'sched.mode.idleHint' : 'sched.mode.onTimeHint')}
      aria-label={label}
      aria-pressed={!idle}
      disabled={disabled}
      onClick={() => onMode?.(entry.id)}
    >
      {idle ? <HourglassGlyph /> : <BoltGlyph />}
      {!short && <span>{label}</span>}
    </button>
  )
}

export interface CancelButtonProps extends EntryButton {
  /** It asks "Cancel?": a second click within four seconds removes the entry. */
  ask: boolean
  onCancel?: ((id: string) => void) | undefined
}

export function CancelButton({ entry, ask, disabled, onCancel }: CancelButtonProps) {
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
      onClick={() => onCancel?.(entry.id)}
    >
      <TrashGlyph />
      <span>{ask ? t('sched.confirm') : ''}</span>
    </button>
  )
}
