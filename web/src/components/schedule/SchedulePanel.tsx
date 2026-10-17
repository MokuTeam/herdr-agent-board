// The schedule panel: what the agents set with `board remind` and `board every`, every entry by
// day, soonest first, after the due ones waiting for their session; then what was sent or missed
// lately. Entries that come in while it is open materialize; opened at a session, its first entry
// scrolls into view and lights up. While a cancelled entry folds away the panel keeps what it
// shows, and draws again once it is gone.
import { Fragment, useLayoutEffect, useRef } from 'react'
import type { BoardPayload } from '../../../../src/core/payload.ts'
import type { Item } from '../../../../src/core/types.ts'
import { appear } from '../../hooks/useFlip.ts'
import { useHeld } from '../../hooks/useHeld.ts'
import type { Schedule } from '../../hooks/useSchedule.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf, type PendingMoves } from '../../models/board-view.ts'
import { entryView, logRecords, newEntries, scheduleGroups } from '../../models/schedule.ts'
import { reducedMotion } from '../../models/spring.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { AlarmGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { ScheduleEntry } from './ScheduleEntry.tsx'
import { ScheduleLog } from './ScheduleLog.tsx'

export interface SchedulePanelProps {
  open: boolean
  /** Opened at a session's entries (the sheet's "+2 more"): a new object for each opening. */
  focus: { key: string } | null
  onClose(): void
  schedule: Schedule
}

export function SchedulePanel({ open, focus, onClose, schedule }: SchedulePanelProps) {
  const t = useT()
  const { data, now, ui, canEdit, dispatch } = useBoardContext()
  const body = useRef<HTMLDivElement>(null)
  const hold = schedule.collapsing > 0
  const shown = {
    data: useHeld(data, hold),
    now: useHeld(now, hold),
    moves: useHeld(ui.moves, hold),
    armed: useHeld(schedule.armed, hold),
  }

  // New entries materialize; on opening the panel its own slide is motion enough.
  const seen = useRef<ReadonlySet<string> | null>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el || !open) {
      seen.current = null
      return
    }
    const rows = [...el.querySelectorAll<HTMLElement>('.sched-entry')]
    const ids = rows.map(row => row.dataset.id ?? '')
    const fresh = new Set(newEntries(ids, seen.current))
    for (const row of rows) if (fresh.has(row.dataset.id ?? '')) appear(row)
    seen.current = new Set(ids)
  })

  useLayoutEffect(() => {
    if (!focus) return
    const rows = body.current?.querySelectorAll<HTMLElement>('.sched-entry') ?? []
    const row = [...rows].find(r => r.dataset.key === focus.key)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    if (!reducedMotion.matches)
      row.animate(
        [{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }, { background: 'transparent' }],
        { duration: 1400, easing: 'ease-out' },
      )
  }, [focus])

  return (
    <Panel
      id="sched-sheet"
      kind="schedule"
      open={open}
      onClose={() => {
        schedule.disarm()
        onClose()
      }}
      title={
        <>
          <h2>{t('sched.title')}</h2>
          <p className="sheet-meta">{t('sched.about')}</p>
        </>
      }
    >
      <div className="sheet-body sched-body" id="sched-body" ref={body}>
        <ScheduleBody
          {...shown}
          disabled={!canEdit}
          onCancel={schedule.cancel}
          onMode={schedule.mode}
          onOpen={key => {
            if (data?.items.some(i => i.key === key)) dispatch({ type: 'open', key })
          }}
        />
      </div>
    </Panel>
  )
}

export interface ScheduleBodyProps {
  data: BoardPayload | null
  now: number
  moves: PendingMoves
  armed: string | null
  disabled: boolean
  onCancel?: (id: string) => void
  onMode?: (id: string) => void
  onOpen?: (key: string) => void
}

/** What #sched-body shows for one board. */
export function ScheduleBody({ data, now, moves, armed, disabled, onCancel, onMode, onOpen }: ScheduleBodyProps) {
  const t = useT()
  const list = data?.schedules ?? []
  const items = data?.items ?? []
  const itemOf = (key: string): Item | undefined => items.find(i => i.key === key)
  const colorOf = (it: Item) => categoryInfo(data?.categories ?? [], catOf(moves, it)).color
  const log = data?.scheduleLog ?? []
  return (
    <>
      {!list.length && (
        <div className="sched-empty">
          <AlarmGlyph />
          <p>{t('sched.empty')}</p>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the board's own dictionary text, with <code> in it */}
          <p className="hint" dangerouslySetInnerHTML={{ __html: t('sched.emptyHint') }} />
        </div>
      )}
      {scheduleGroups(list, now, t).map(group => (
        <Fragment key={`${group.title} ${group.entries[0]?.entry.id}`}>
          <div className="section-title">{group.title}</div>
          <div className="group sched-group">
            {group.entries.map(({ entry, time }) => (
              <ScheduleEntry
                key={entry.id}
                entry={entry}
                view={entryView(entry, itemOf, colorOf, t)}
                time={time}
                ask={armed === entry.id}
                disabled={disabled}
                onCancel={onCancel}
                onMode={onMode}
                onOpen={onOpen}
              />
            ))}
          </div>
        </Fragment>
      ))}
      {log.length > 0 && (
        <>
          <div className="section-title">{t('sched.recent')}</div>
          <div className="group sched-log">
            <ScheduleLog records={logRecords(log)} itemOf={itemOf} now={now} />
          </div>
        </>
      )}
    </>
  )
}
