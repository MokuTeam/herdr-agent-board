// The device switch (#502, docs/design/nodes 12), right after the profile switch and built like it:
// "All devices" and each device of the payload with its cards on show, a thumb under the picked one.
// The toolbar draws it only while the payload has more than one device (models/devices.ts
// deviceOptions), so a board without `nodes` never has it. It folds into a pill as the other
// controls do (hooks/useSegmentFolds.ts finds it by its id).
import { useRef } from 'react'
import type { SegmentPicks } from '../../hooks/useSegmentPicks.ts'
import { useSegmentThumb } from '../../hooks/useSegmentThumb.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { ProfileOption } from '../../models/profiles.ts'
import { SegmentPick } from '../SegmentPick.tsx'

interface Props {
  options: ProfileOption[]
  /** 'all' or the id of the device on show. */
  picked: string
  onPick: (id: string) => void
  /** Folded into its pill. */
  folded?: boolean
  /** The pill's menu (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks | undefined
}

export function DeviceSwitch({ options, picked, onPick, folded = false, picks }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, picked, options.map(o => `${o.id}:${o.title}:${o.n}`).join('|'))
  return (
    <>
      <div
        className="segmented devices"
        id="devices"
        role="tablist"
        aria-label={t('node.devices')}
        hidden={folded}
        ref={control}
      >
        <span className="thumb" ref={thumb} />
        {options.map(o => (
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
      {folded && (
        <SegmentPick
          of="devices"
          name="node.pick"
          choices={{ label: t('node.devices'), options, picked: [picked], tint: false, onPick }}
          picks={picks}
        />
      )}
    </>
  )
}
