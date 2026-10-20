// What a card says of its session's helpers and of the sessions it works with (the old page's
// app.js helpersChip, relationsLine): the helpers at work, only while they work, and quietly at
// its foot who started it and how many it started. The board takes the clicks (data-act).
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { liveCount } from '../../models/helper-model.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { ForkIcon } from '../icons.tsx'
import { FromGlyph, SpawnedGlyph } from './glyphs.tsx'

/**
 * Helpers at work, on the card: a dot for each (its kind's color, a teammate's own), how many,
 * and what the newest one does. Only while they work: a finished helper is the sheet's to show.
 */
export function HelpersChip({ item }: { item: Item }) {
  const t = useT()
  const n = liveCount(item)
  if (!n) return null
  const live = item.helpers?.live ?? []
  const label = live[0]?.label ?? ''
  return (
    <div className="helpers-row">
      <button type="button" className="helpers-chip" data-act="helpers" title={t('helpers.chipHint')}>
        <span className="hdots">
          {live.length ? (
            live.slice(0, 3).map(h => <i key={h.id} className={`hd k-${h.kind}`} data-color={h.color || undefined} />)
          ) : (
            <i className="hd k-workflow" />
          )}
        </span>
        <span className="n">{t('helpers.chip', { n })}</span>
        {label && <span className="d">{label}</span>}
      </button>
    </div>
  )
}

/** Who started this session and how many it started, quietly at the card's foot. */
export function Relations({ item }: { item: Item }) {
  const t = useT()
  const { data } = useBoardContext()
  const l = item.links
  if (!l) return null
  const itemOf = (key: string) => data?.items.find(i => i.key === key)
  const from = l.from ? itemOf(l.from.key) : undefined
  const started = (l.started ?? []).map(x => itemOf(x.key)).filter((x): x is Item => !!x)
  if (!from && !started.length) return null
  return (
    <div className="rels">
      {from && (
        <button
          type="button"
          className="rel"
          data-act="rel"
          data-key={from.key}
          title={t(l.from?.fork ? 'rel.forkOfHint' : 'rel.fromHint', { name: from.name })}
        >
          {l.from?.fork ? <ForkIcon /> : <FromGlyph />}
          <span>{from.name}</span>
        </button>
      )}
      {started.length > 0 && (
        <span className="rel" title={t('rel.startedHint', { names: started.map(x => x.name).join(', ') })}>
          <SpawnedGlyph />
          <span>{t('rel.started', { n: started.length })}</span>
        </span>
      )}
    </div>
  )
}
