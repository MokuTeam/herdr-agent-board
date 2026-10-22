// A toolbar control folded into one pill (hooks/useSegmentFolds.ts), in its segments' place: the
// choice on show with its count, as its segment showed them, and a chevron; the lanes on show,
// when several are, by their names and their sessions together. Pressed, or ↓ on it, every
// choice opens in a menu under it (hooks/useSegmentPicks.ts). Its name says what it switches and
// to what: "Category: bluBanyan", "Categories: bluBanyan, Other".
import type { SegmentChoices, SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { pickedOptions } from '../models/segment-fold.ts'
import { classNames } from './class-names.ts'
import { DownIcon } from './icons.tsx'

interface Props {
  /** Its control's id (`lanes`, `profiles`): the pill is `<id>-pick`. */
  of: string
  /** Its name's text key, with the choice on show as {title}. */
  name: string
  /** The same with several choices on show, their names as {title} (the lanes). */
  nameMany?: string
  choices: SegmentChoices
  picks?: SegmentPicks | undefined
}

export function SegmentPick({ of, name, nameMany = name, choices, picks }: Props) {
  const t = useT()
  const lit = pickedOptions(choices.options, choices.picked)
  const option = lit[0]
  if (!option) return null
  const title = lit.map(o => o.title).join(', ')
  const n = lit.reduce((sum, o) => sum + o.n, 0)
  const label = t(lit.length > 1 ? nameMany : name, { title })
  // A click with no pointer (detail 0) came from the keys, as the gear's.
  const open = (button: HTMLElement, keyboard: boolean) => picks?.open(of, button, keyboard, choices)
  return (
    <button
      type="button"
      className={classNames('pill-toggle segment-pick', choices.tint && 'profiles', lit.length > 1 && 'many')}
      id={`${of}-pick`}
      style={choices.tint ? { '--c': option.color } : undefined}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={picks?.expanded === of}
      onClick={e => open(e.currentTarget, e.detail === 0)}
      onKeyDown={e => {
        if (e.key !== 'ArrowDown') return
        e.preventDefault()
        open(e.currentTarget, true)
      }}
    >
      <span className="segment-pick-title">{title}</span>
      <span className="n">{n}</span>
      <DownIcon />
    </button>
  )
}
