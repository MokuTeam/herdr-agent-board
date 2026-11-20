// A watch on a waiting card (#486): under what it waits for, how its probe stands ("checked 4 min
// ago, nothing yet", "probe error: …, next try in 20 min"), the whole command in its title. Nothing
// for a session without a watch, which is every session while watches are off.
import { useEffect } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { linkWatchesSheet, watchOf, watchView } from '../models/watch.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { classNames } from './class-names.ts'

export function WatchLine({ item }: { item: Item }) {
  const t = useT()
  const { data, now } = useBoardContext()
  const watch = watchOf(data?.schedules ?? [], item.key)
  useEffect(() => {
    if (watch) linkWatchesSheet()
  }, [watch])
  if (!watch) return null
  const view = watchView(watch, now, t)
  return (
    <div
      className={classNames('watch-line', view.error && 'error')}
      data-watch={watch.id}
      title={`${view.every}: ${view.cmd}`}
    >
      {view.state}
    </div>
  )
}
