// A clock by a card's name with the soonest schedule entry's time; orange while a due one waits.
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { alarmOf } from '../models/card.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { AlarmGlyph, RepeatGlyph } from './icons.tsx'

export function AlarmBadge({ item }: { item: Item }) {
  const t = useT()
  const { data, now } = useBoardContext()
  const alarm = alarmOf(data?.schedules ?? [], item.key, now, t)
  if (!alarm) return null
  return (
    <span className={alarm.due ? 'alarm due' : 'alarm'} title={alarm.title}>
      {alarm.repeat ? <RepeatGlyph /> : <AlarmGlyph />}
      <span>{alarm.when}</span>
    </span>
  )
}
