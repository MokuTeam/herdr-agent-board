// The lanes control: "All" and the categories with sessions on show, a thumb under the picked one;
// it fades out at an edge with more lanes past it. Where the toolbar has no room for all of them
// (hooks/useSegmentFolds.ts) it folds: the segments hide and a pill naming the lane on show takes
// their place, every lane in its menu.
import { useRef } from 'react'
import { useLaneFades } from '../hooks/useLaneFades.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useSegmentThumb } from '../hooks/useSegmentThumb.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { LaneOption } from '../models/toolbar.ts'
import { SegmentPick } from './SegmentPick.tsx'

interface Props {
  /** null before the first board: the control stays empty. */
  options: LaneOption[] | null
  picked: string
  onPick: (id: string) => void
  /** Folded into its pill. */
  folded?: boolean
  /** The pill's menu (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks | undefined
}

export function Lanes({ options, picked, onPick, folded = false, picks }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, picked, options?.map(o => `${o.id}:${o.title}:${o.n}`).join('|') ?? '')
  useLaneFades(control)
  return (
    <>
      <div className="segmented" id="lanes" role="tablist" aria-label={t('tb.lanes')} hidden={folded} ref={control}>
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
      {folded && options && (
        <SegmentPick
          of="lanes"
          name="tb.lanesPick"
          choices={{ label: t('tb.lanes'), options, picked, tint: false, onPick }}
          picks={picks}
        />
      )}
    </>
  )
}
