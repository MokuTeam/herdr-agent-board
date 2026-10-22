// The profile switch, right after the lanes control and built like it: "All profiles" and each
// shown profile with its sessions on show, a thumb under the picked one. The toolbar draws it only
// with two or more profiles shown (models/profiles.ts profileOptions). It folds into a pill as the
// lanes control does (hooks/useSegmentFolds.ts), each profile's count in its color there too.
import { useRef } from 'react'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useSegmentThumb } from '../hooks/useSegmentThumb.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { ProfileOption } from '../models/profiles.ts'
import { SegmentPick } from './SegmentPick.tsx'

interface Props {
  options: ProfileOption[]
  /** 'all' or the id of the profile on show. */
  picked: string
  onPick: (id: string) => void
  /** Folded into its pill. */
  folded?: boolean
  /** The pill's menu (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks | undefined
}

export function ProfileSwitch({ options, picked, onPick, folded = false, picks }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, picked, options.map(o => `${o.id}:${o.title}:${o.n}`).join('|'))
  return (
    <>
      <div
        className="segmented profiles"
        id="profiles"
        role="tablist"
        aria-label={t('tb.profiles')}
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
            style={{ '--c': o.color }}
            onClick={() => onPick(o.id)}
          >
            {o.title}
            <span className="n">{o.n}</span>
          </button>
        ))}
      </div>
      {folded && (
        <SegmentPick
          of="profiles"
          name="tb.profilesPick"
          choices={{ label: t('tb.profiles'), options, picked: [picked], tint: true, onPick }}
          picks={picks}
        />
      )}
    </>
  )
}
