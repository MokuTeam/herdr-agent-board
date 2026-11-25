// The segmented control of Settings (#651): one of a few choices, the picked one raised. Shared by
// Settings and Settings, Devices (#789). An option may carry a title: its words for the tooltip and
// for a screen reader when its label is a glyph.
import { classNames } from '../class-names.ts'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** Its words, when the label alone does not say them (a glyph). */
  title?: string
}

export function Segmented<T extends string>({
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  disabled?: boolean
  label: string
  onChange(value: T): void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: group keeps compact inline flex sizing without fieldset min-inline-size
    <div className="set-seg" role="group" aria-label={label}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          disabled={disabled}
          className={classNames('set-seg-opt', opt.value === value && 'on')}
          title={opt.title}
          aria-label={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
