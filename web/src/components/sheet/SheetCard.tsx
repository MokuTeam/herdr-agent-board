// The card's own fields, in the sheet's head under its name (its lane and column are the head's
// pills): what it does and what it waits for when they say something (Enter saves a field,
// Escape puts it back), its reminders, and the sessions it works with. Opened, the empty fields
// are one quiet Add row, so they do not cost two rows until they are asked for. A field being
// edited keeps what is typed while the board moves on. A Claude session's auto-compact (#378):
// its own limit and what its summary keeps, with the board's last /compact, shown while the card
// is open or once anything is set (models/compact.ts).
import { type KeyboardEvent, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { plain } from '../../models/card.ts'
import {
  compactLabel,
  compactNotePlaceholder,
  compactPlaceholder,
  compactRunText,
  offersCompact,
} from '../../models/compact.ts'
import { doingLabel, type FieldEdit, type FieldScene, liveEdit, typing } from '../../models/sheet.ts'
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
  // Empty fields stay out of the way even when the card's details are open: one quiet "Add"
  // row offers the ones that can still be filled, and only the one asked for opens.
  const [revealed, setRevealed] = useState<{ doing?: boolean; wait?: boolean }>({})
  const showDoing = !!item.doing || (open && !!revealed.doing)
  const showWait = !!item.wait || (open && !!revealed.wait)
  const addDoing = open && !item.doing && !revealed.doing
  const addWait = open && !item.wait && !revealed.wait
  return (
    <div className="group">
      {showDoing && (
        <div className="row">
          <span className="row-label">{doingLabel(item, t)}</span>
          <CardField
            item={item}
            field="doing"
            placeholder={plain(fromTitle) || t('row.doingNone')}
            disabled={disabled}
          />
        </div>
      )}
      {showWait && (
        <div className="row">
          <span className="row-label">{t('row.wait')}</span>
          <CardField item={item} field="wait" placeholder={t('row.waitNone')} disabled={disabled} />
        </div>
      )}
      {(addDoing || addWait) && (
        <div className="row add-row">
          <span className="row-label">{t('row.add')}</span>
          <div className="row-value add-fields">
            {addDoing && (
              <button
                type="button"
                className="add-field"
                disabled={disabled}
                onClick={() => setRevealed(shown => ({ ...shown, doing: true }))}
              >
                {t('row.addDoing')}
              </button>
            )}
            {addWait && (
              <button
                type="button"
                className="add-field"
                disabled={disabled}
                onClick={() => setRevealed(shown => ({ ...shown, wait: true }))}
              >
                {t('row.addWait')}
              </button>
            )}
          </div>
        </div>
      )}
      <CompactRows item={item} open={open} disabled={disabled} />
      <Reminders item={item} disabled={disabled} schedule={schedule} />
      <RelationsRow item={item} onSession={key => onSession?.(key)} />
    </div>
  )
}

/**
 * Auto-compact (#378): the session's own limit (empty: Settings' default, shown as the
 * placeholder), what its summary keeps once a limit applies, and the board's last /compact.
 */
function CompactRows({ item, open, disabled }: Pick<SheetCardProps, 'item' | 'open' | 'disabled'>) {
  const t = useT()
  const { data, now } = useBoardContext()
  const view = item.compact
  if (!offersCompact(item, open)) return null
  const run = view?.run ? compactRunText(view.run, t, now) : null
  const showNote = !!view?.note || (open && !!view?.limit)
  return (
    <>
      <div className="row compact-row">
        <span className="row-label">{compactLabel(t)}</span>
        <CardField
          item={item}
          field="compactAt"
          saved={view?.own ?? ''}
          placeholder={compactPlaceholder(view, data?.compactDefault ?? '', t)}
          disabled={disabled}
        />
      </div>
      {showNote && (
        <div className="row compact-row">
          <span className="row-label">{t('compact.keeps')}</span>
          <CardField
            item={item}
            field="compactNote"
            saved={view?.note ?? ''}
            placeholder={compactNotePlaceholder(view, t)}
            disabled={disabled}
          />
        </div>
      )}
      {run && (
        <div className="row compact-row">
          <span className="row-label">{t('compact.last')}</span>
          <span className={`row-value compact-run${run.held ? ' held' : ''}`} title={run.hint || undefined}>
            {run.text}
          </span>
        </div>
      )}
    </>
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
      forceExpanded={!!held}
      {...actions}
    />
  )
}

interface CardFieldProps {
  item: Item
  field: 'doing' | 'wait' | 'compactAt' | 'compactNote'
  /** What the card holds for the field, when it is not the item's own field of that name. */
  saved?: string
  placeholder: string
  disabled: boolean
}

/**
 * One of the card's own lines: Enter saves it on the card (the toast says so), Escape puts it back.
 * A long one wraps (three lines, then it scrolls; the tooltip has it whole) and stays one line of
 * text: a line break pasted in is a space.
 */
function CardField({ item, field, saved, placeholder, disabled }: CardFieldProps) {
  const t = useT()
  const { toast } = useBoardContext()
  const actions = useSessionActions()
  const [edit, setEdit] = useState<FieldEdit | null>(null)
  const [focused, setFocused] = useState(false)
  const own = saved ?? (field === 'doing' || field === 'wait' ? item[field] : '')
  const scene: FieldScene = { focused, saved: own ?? '', session: item.key }
  // An edit that is over is dropped, so a value coming back later cannot bring it back.
  const live = liveEdit(edit, scene)
  if (live !== edit) setEdit(live)

  async function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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

  const shown = live?.text ?? scene.saved
  return (
    <textarea
      className="row-value"
      id={field}
      rows={1}
      value={shown}
      title={shown || undefined}
      placeholder={placeholder}
      disabled={disabled}
      onChange={e => setEdit(typing(edit, scene, e.target.value.replace(/\s*[\r\n]+\s*/g, ' ')))}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={e => void onKeyDown(e)}
    />
  )
}
