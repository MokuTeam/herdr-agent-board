// The sessions this one works with, among its card's fields in the sheet (the old page's app.js
// relationsRow): who started it, whom it started, whom it wrote with and how often each way. A
// name opens that session. They work whatever the board can do: they only go somewhere.
import { useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf } from '../../models/board-view.ts'
import { ago } from '../../models/card.ts'
import { linkedSessions } from '../../models/helper-model.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { FromGlyph, SpawnedGlyph } from './glyphs.tsx'

// Sessions whose sheet shows every linked session, not the first few (for as long as the page is open).
const relAll = new Set<string>()

export function RelationsRow({ item, onSession }: { item: Item; onSession: (key: string) => void }) {
  const t = useT()
  const { data, ui, now } = useBoardContext()
  const [, setShown] = useState(0)
  const itemOf = (key: string) => data?.items.find(i => i.key === key)
  const peers = linkedSessions(item, key => !!itemOf(key))
  if (!peers.length) return null
  const all = relAll.has(item.key) || peers.length <= 6
  return (
    <div className="row rel-row">
      <span className="row-label">{t('rel.row')}</span>
      <div className="row-value rel-chips">
        {(all ? peers : peers.slice(0, 5)).map(p => {
          const other = itemOf(p.key)
          if (!other) return null
          const title = [
            p.from && t('rel.fromHint', { name: other.name }),
            p.started && t('rel.startedThis'),
            (p.in || p.out) && t('rel.talkHint', { name: other.name, in: p.in, out: p.out, when: ago(p.at, now, t) }),
          ]
            .filter(Boolean)
            .join('\n')
          const color = categoryInfo(data?.categories ?? [], catOf(ui.moves, other)).color
          return (
            <button
              type="button"
              key={p.key}
              className="rel-chip"
              data-session={p.key}
              style={{ '--lane': color }}
              title={title}
              onClick={() => onSession(p.key)}
            >
              {(p.from || p.started) && (
                <span className="rel-marks">
                  {p.from && <FromGlyph />}
                  {p.started && <SpawnedGlyph />}
                </span>
              )}
              <span className="rel-name">{other.name}</span>
              {(p.in > 0 || p.out > 0) && (
                <span className="rel-io">
                  {p.in > 0 && <i>↓{p.in}</i>}
                  {p.out > 0 && <i>↑{p.out}</i>}
                </span>
              )}
            </button>
          )
        })}
        {!all && (
          <button
            type="button"
            className="rel-more"
            data-rel-all=""
            onClick={() => {
              relAll.add(item.key)
              setShown(n => n + 1)
            }}
          >
            {t('rel.more', { n: peers.length - 5 })}
          </button>
        )}
      </div>
    </div>
  )
}
