// The lanes control: "All" and the categories with sessions on show, a thumb under the picked one.
import { useRef } from 'react'
import { useSegmentThumb } from '../hooks/useSegmentThumb.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { LaneOption } from '../models/toolbar.ts'

interface Props {
  /** null before the first board: the control stays empty. */
  options: LaneOption[] | null
  picked: string
  onPick: (id: string) => void
}

export function Lanes({ options, picked, onPick }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, picked, options?.map(o => `${o.id}:${o.title}:${o.n}`).join('|') ?? '')
  return (
    <div className="segmented" id="lanes" role="tablist" aria-label={t('tb.lanes')} ref={control}>
      {options && <span className="thumb" ref={thumb} />}
      {options?.map(o => (
        <button
          type="button"
          key={o.id}
          role="tab"
          data-id={o.id}
          aria-selected={o.id === picked}
          onClick={() => onPick(o.id)}
        >
          {o.title}
          <span className="n">{o.n}</span>
        </button>
      ))}
    </div>
  )
}
