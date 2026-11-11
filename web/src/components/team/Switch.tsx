// The team panel's switch: a track with a knob, for the agents' switches and the passkey's (#367).

/** A switch: a track with a knob, the accent's when on. */
export function Switch({
  on,
  label,
  name,
  disabled,
  onFlip,
}: {
  on: boolean
  label: string
  name: string
  disabled: boolean
  onFlip(on: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      className="team-switch"
      data-switch={name}
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onFlip(!on)}
    >
      <span className="team-knob" aria-hidden="true" />
    </button>
  )
}
