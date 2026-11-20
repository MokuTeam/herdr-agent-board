// A session's decisions in its sheet (#487): the questions it asked that are closed, newest first,
// with the answer and who gave it (the owner, by button or in words; the default; withdrawn). Read
// from GET /api/decisions?session=<key> when the sheet opens on it and whenever its open question
// changes; folded to a line that counts them.
import { useEffect, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { api, isReply } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ago } from '../../models/card.ts'
import { closedBy, isDecisionRecord, type DecisionRecord as Row } from '../../models/decisions.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

export function DecisionRecord({ item }: { item: Item }) {
  const t = useT()
  const { now } = useBoardContext()
  const [rows, setRows] = useState<Row[]>([])
  const asked = item.decision?.id ?? ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when its open question changes
  useEffect(() => {
    let live = true
    api
      .get(`/api/decisions?session=${encodeURIComponent(item.key)}`, isReply, { cache: 'no-store' })
      .then(r => {
        if (live) setRows(Array.isArray(r.done) ? r.done.filter(isDecisionRecord) : [])
      })
      .catch(() => {
        if (live) setRows([])
      })
    return () => {
      live = false
    }
  }, [item.key, asked])
  if (!rows.length) return null
  return (
    <details className="dec-record">
      <summary>
        {t('dec.record')} <span className="n">{rows.length}</span>
      </summary>
      {rows.map(r => (
        <div key={r.id} className="dec-record-row">
          <p className="dec-q">{r.question}</p>
          <p className="dec-meta">
            <span className="dec-answer">{r.answer ? `"${r.answer}"` : t('dec.noAnswer')}</span>
            {' · '}
            {closedBy(r, t)}
            {r.answeredAt ? ` · ${ago(r.answeredAt, now, t)}` : ''}
          </p>
        </div>
      ))}
    </details>
  )
}
