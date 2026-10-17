// The card's own fields, pinned under the sheet's head: its lane and column as chips ("Auto" takes
// a pin off), what it does and what it waits for — Enter saves a field, Escape puts it back — and
// its reminders. A field being edited keeps what is typed while the board moves on.
import { type KeyboardEvent, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { catOf, colOf } from '../../models/board-view.ts'
import { plain } from '../../models/card.ts'
import { type FieldEdit, type FieldScene, liveEdit, typing } from '../../models/sheet.ts'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { type ScheduleActions, ScheduleRow } from './ScheduleRow.tsx'

export interface SheetCardProps {
  item: Item
  /** The chips, fields and reminder buttons do nothing now. */
  disabled: boolean
  schedule?: ScheduleActions | undefined
}

export function SheetCard({ item, disabled, schedule }: SheetCardProps) {
  const t = useT()
  const { data, ui, now } = useBoardContext()
  const actions = useSessionActions()
  const q = (s: string) => t('q', { s })
  const cat = catOf(ui.moves, item)
  const col = colOf(ui.moves, item)
  // Columns the user can put it in; "Auto" drops the pin and lets the board decide again.
  const pinned = !!item.pin && col === item.pin
  const auto = item.auto
  const fromTitle = item.title && item.title !== item.name ? item.title : ''
  return (
    <div className="group">
      <div className="row">
        <span className="row-label">{t('row.category')}</span>
        <div className="row-value chips" id="cats">
          {(data?.categories ?? []).map(c => (
            <button
              type="button"
              key={c.id}
              data-cat={c.id}
              style={{ '--lane': c.color }}
              aria-pressed={cat === c.id}
              disabled={disabled}
              onClick={() => void actions.moveCard(item.key, { cat: c.id, column: null })}
            >
              {c.title}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="row-label">{t('row.status')}</span>
        <div className="row-value chips" id="cols">
          {(data?.columns ?? [])
            .filter(c => c.id !== 'work')
            .map(c => (
              <button
                type="button"
                key={c.id}
                data-col={c.id}
                style={{ '--lane': COLUMN_COLORS[c.id] }}
                aria-pressed={col === c.id}
                disabled={disabled}
                onClick={() => void actions.moveCard(item.key, { cat: null, column: c.id })}
              >
                {c.title}
              </button>
            ))}
          {pinned && auto && (
            <button
              type="button"
              className="auto"
              data-col={auto}
              title={t('chip.autoTitle', { col: q(t(`col.${auto}`)) })}
              disabled={disabled}
              onClick={() => void actions.moveCard(item.key, { cat: null, column: auto })}
            >
              {t('chip.auto')}
            </button>
          )}
        </div>
      </div>
      <div className="row">
        <span className="row-label">{t('row.doing')}</span>
        <CardField item={item} field="doing" placeholder={plain(fromTitle) || t('row.doingNone')} disabled={disabled} />
      </div>
      <div className="row">
        <span className="row-label">{t('row.wait')}</span>
        <CardField item={item} field="wait" placeholder={t('row.waitNone')} disabled={disabled} />
      </div>
      <ScheduleRow
        entries={(data?.schedules ?? []).filter(e => e.key === item.key)}
        now={now}
        disabled={disabled}
        {...schedule}
      />
    </div>
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
