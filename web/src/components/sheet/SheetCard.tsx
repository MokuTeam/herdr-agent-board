// The card's own fields, in the sheet's head under its name (its lane and column are the head's
// pills): what it does and what it waits for, when they say something or are opened to be filled
// (Enter saves a field, Escape puts it back), its reminders, and the sessions it works with. A
// field being edited keeps what is typed while the board moves on.
import { type KeyboardEvent, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { plain } from '../../models/card.ts'
import { type FieldEdit, type FieldScene, liveEdit, typing } from '../../models/sheet.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { RelationsRow } from '../helpers/RelationsRow.tsx'
import { type ScheduleActions, ScheduleRow } from './ScheduleRow.tsx'

export interface SheetCardProps {
  item: Item
  /** What it does and what it waits for show with nothing in them too, to be filled. */
  open: boolean
  /** The fields and reminder buttons do nothing now. */
  disabled: boolean
  schedule?: ScheduleActions | undefined
  /** A linked session's name: that session (they work whatever the board can do). */
  onSession?: ((key: string) => void) | undefined
}

export function SheetCard({ item, open, disabled, schedule, onSession }: SheetCardProps) {
  const t = useT()
  const fromTitle = item.title && item.title !== item.name ? item.title : ''
  // What it does and what it waits for show when they say something, or to be filled.
  return (
    <div className="group">
      {(open || !!item.doing) && (
        <div className="row">
          <span className="row-label">{t('row.doing')}</span>
          <CardField
            item={item}
            field="doing"
            placeholder={plain(fromTitle) || t('row.doingNone')}
            disabled={disabled}
          />
        </div>
      )}
      {(open || !!item.wait) && (
        <div className="row">
          <span className="row-label">{t('row.wait')}</span>
          <CardField item={item} field="wait" placeholder={t('row.waitNone')} disabled={disabled} />
        </div>
      )}
      <Reminders item={item} disabled={disabled} schedule={schedule} />
      <RelationsRow item={item} onSession={key => onSession?.(key)} />
    </div>
  )
}

/** The session's reminders: while a cancelled one folds away, as they were when the fold began. */
function Reminders({ item, disabled, schedule = {} }: Pick<SheetCardProps, 'item' | 'disabled' | 'schedule'>) {
  const { data, now } = useBoardContext()
  const { held, armed, ...actions } = schedule
  const shown = held ? { ...held.view, armed: held.armed } : { data, now, armed }
  return (
    <ScheduleRow
      entries={(shown.data?.schedules ?? []).filter(e => e.key === item.key)}
      now={shown.now}
      disabled={disabled}
      armed={shown.armed}
      {...actions}
    />
  )
}

interface CardFieldProps {
  item: Item
  field: 'doing' | 'wait'
  placeholder: string
  disabled: boolean
}

/** One of the card's own lines: Enter saves it on the card (the toast says so), Escape puts it back. */
function CardField({ item, field, placeholder, disabled }: CardFieldProps) {
  const t = useT()
  const { toast } = useBoardContext()
  const actions = useSessionActions()
  const [edit, setEdit] = useState<FieldEdit | null>(null)
  const [focused, setFocused] = useState(false)
  const scene: FieldScene = { focused, saved: item[field] ?? '', session: item.key }
  // An edit that is over is dropped, so a value coming back later cannot bring it back.
  const live = liveEdit(edit, scene)
  if (live !== edit) setEdit(live)

  async function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const input = e.currentTarget
    if (e.key === 'Escape') {
      setEdit(null)
      input.blur()
      e.stopPropagation()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const value = input.value
    const r = await actions.act(item.key, 'card', { [field]: value })
    input.blur()
    const done = field === 'wait' ? (value.trim() ? 'toast.waitSet' : 'toast.waitCleared') : 'saved'
    toast(r.ok ? t(done) : r.error, !r.ok)
  }

  return (
    <input
      className="row-value"
      id={field}
      value={live?.text ?? scene.saved}
      placeholder={placeholder}
      disabled={disabled}
      onChange={e => setEdit(typing(edit, scene, e.target.value))}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={e => void onKeyDown(e)}
    />
  )
}
