// "4 sessions · 1 working · 1 needs you · 2 asleep" under the title; "Loading…" before the first board.
import { Fragment } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import type { SummaryPart } from '../models/toolbar.ts'

export function Summary({ parts }: { parts: SummaryPart[] | null }) {
  const t = useT()
  return (
    <p className="summary" id="summary">
      {parts
        ? parts.map((part, i) => (
            <Fragment key={part.id}>
              {i > 0 && ' · '}
              {part.strong ? <b>{part.n}</b> : part.n}
              {` ${part.text}`}
            </Fragment>
          ))
        : t('loading')}
    </p>
  )
}
