// The profile switch, right after the lanes control and built like it: "All profiles" and each
// shown profile with its sessions on show, a thumb under the picked one. The toolbar draws it only
// with two or more profiles shown (models/profiles.ts profileOptions).
import { useRef } from 'react'
import { useSegmentThumb } from '../hooks/useSegmentThumb.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { ProfileOption } from '../models/profiles.ts'

interface Props {
  options: ProfileOption[]
  /** 'all' or the id of the profile on show. */
  picked: string
  onPick: (id: string) => void
}

export function ProfileSwitch({ options, picked, onPick }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, picked, options.map(o => `${o.id}:${o.title}:${o.n}`).join('|'))
  return (
    <div className="segmented profiles" id="profiles" role="tablist" aria-label={t('tb.profiles')} ref={control}>
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
  )
}
