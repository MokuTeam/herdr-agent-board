// The chat box's slash command list (#191): over the box, as the box sits at the sheet's foot. A
// row is the command, what it takes and what it does; a tap or a click completes the box with it
// and leaves the keyboard where it was (hooks/useSlash.ts).
import { useLayoutEffect, useRef } from 'react'
import type { SlashBox } from '../../hooks/useSlash.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { classNames } from '../class-names.ts'

export const SLASH_MENU_ID = 'slash-menu'
export const slashOptionId = (i: number): string => `slash-option-${i}`

export function SlashMenu({ slash }: { slash: SlashBox }) {
  const t = useT()
  const menu = useRef<HTMLDivElement>(null)
  const { open, list, active, argument } = slash

  // The lit row in sight, as the arrows move it past the list's edge.
  useLayoutEffect(() => {
    if (!open) return
    const row = menu.current?.children[active] as HTMLElement | undefined
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  if (!open) {
    if (!argument?.hint) return null
    return (
      <div className="slash-hint" aria-hidden="true">
        <span className="slash-name">/{argument.name}</span> <span className="slash-arg">{argument.hint}</span>
      </div>
    )
  }
  return (
    <div className="slash-menu">
      <div className="slash-list" id={SLASH_MENU_ID} role="listbox" aria-label={t('slash.label')} ref={menu}>
        {list.map((c, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the box's arrows, Tab and Enter pick (aria-activedescendant)
          // biome-ignore lint/a11y/useFocusableInteractive: as above: the focus stays in the box
          <div
            key={c.name}
            id={slashOptionId(i)}
            role="option"
            aria-selected={i === active}
            className={classNames('slash-option', i === active && 'active')}
            onPointerDown={e => e.preventDefault()}
            onPointerMove={() => {
              if (i !== active) slash.hover(i)
            }}
            onClick={() => slash.pick(i)}
          >
            <span className="slash-head">
              <span className="slash-name">/{c.name}</span>
              {c.hint && <span className="slash-arg">{c.hint}</span>}
            </span>
            <span className="slash-about">
              {c.description}
              {c.source !== 'builtin' && <span className="slash-source">{t(`slash.${c.source}`)}</span>}
            </span>
          </div>
        ))}
      </div>
      <p className="slash-keys" aria-hidden="true">
        {t('slash.keys')}
      </p>
    </div>
  )
}
