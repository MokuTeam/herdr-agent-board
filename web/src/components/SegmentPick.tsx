// A toolbar control folded into one pill (hooks/useSegmentFolds.ts), in its segments' place: the
// choice on show with its count, as its segment showed them, and a chevron. Pressed, or ↓ on it,
// every choice opens in a menu under it (hooks/useSegmentPicks.ts). Its name says what it
// switches and to what: "Category: bluBanyan".
import type { SegmentChoices, SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { pickedOption } from '../models/segment-fold.ts'
import { classNames } from './class-names.ts'
import { DownIcon } from './icons.tsx'

interface Props {
  /** Its control's id (`lanes`, `profiles`): the pill is `<id>-pick`. */
  of: string
  /** Its name's text key, with the choice on show as {title}. */
  name: string
  choices: SegmentChoices
  picks?: SegmentPicks | undefined
}

export function SegmentPick({ of, name, choices, picks }: Props) {
  const t = useT()
  const option = pickedOption(choices.options, choices.picked)
  if (!option) return null
  const label = t(name, { title: option.title })
  // A click with no pointer (detail 0) came from the keys, as the gear's.
  const open = (button: HTMLElement, keyboard: boolean) => picks?.open(of, button, keyboard, choices)
  return (
    <button
      type="button"
      className={classNames('pill-toggle segment-pick', choices.tint && 'profiles')}
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
      <span className="segment-pick-title">{option.title}</span>
      <span className="n">{option.n}</span>
      <DownIcon />
    </button>
  )
}
