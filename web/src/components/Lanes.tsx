// The lanes control: "All" and the categories with sessions on show, any set of them on show at
// once. A click puts a lane on show or takes it off again, "All" shows every lane; each lane on
// show is lit ("All" while none is picked). It fades out at an edge with more lanes past it.
// Where the toolbar has no room for all of them (hooks/useSegmentFolds.ts) it folds: the segments
// hide and a pill naming the lanes on show takes their place, every lane in its menu, which stays
// open while lanes are checked on and off.
import { useRef } from 'react'
import { useLaneFades } from '../hooks/useLaneFades.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type LanePicks, litLanes, toggledLane } from '../models/lane-picks.ts'
import type { LaneOption } from '../models/toolbar.ts'
import { SegmentPick } from './SegmentPick.tsx'

interface Props {
  /** null before the first board: the control stays empty. */
  options: LaneOption[] | null
  /** The lanes picked (models/lane-picks.ts); none: every lane. */
  picked: LanePicks
  /** A lane clicked: on show or off again ('all': every lane). */
  onPick: (id: string) => void
  /** Folded into its pill. */
  folded?: boolean
  /** The pill's menu (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks | undefined
}

/** The lanes lit after a pick in the pill's menu, as a click on that segment leaves them. */
const toggled = (lit: readonly string[], id: string) => litLanes(toggledLane(lit, id))

export function Lanes({ options, picked, onPick, folded = false, picks }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  useLaneFades(control)
  const lit = litLanes(picked)
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> keeps its content's width (min-inline-size), so the strip could not scroll or fold */}
      <div
        className="segmented lane-picks"
        id="lanes"
        role="group"
        aria-label={t('tb.lanes')}
        hidden={folded}
        ref={control}
      >
        {options?.map(o => (
          <button
            type="button"
            key={o.id}
            data-id={o.id}
            aria-pressed={lit.includes(o.id)}
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
          nameMany="tb.lanesPicked"
          choices={{ label: t('tb.lanes'), options, picked: lit, tint: false, toggled, onPick }}
          picks={picks}
        />
      )}
    </>
  )
}
