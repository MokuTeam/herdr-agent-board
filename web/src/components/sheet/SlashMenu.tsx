// The chat box's slash command list (#191): over the box, as the box sits at the sheet's foot. A
// row is the command, what it takes and what it does; a tap or a click completes the box with it
// and leaves the keyboard where it was (hooks/useSlash.ts).
import { type RefObject, useLayoutEffect, useRef } from 'react'
import type { SlashBox } from '../../hooks/useSlash.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { classNames } from '../class-names.ts'
import { useSheetId } from './sheet-ids.ts'

export const SLASH_MENU_ID = 'slash-menu'
export const slashOptionId = (i: number): string => `slash-option-${i}`

export function SlashMenu({
  slash,
  text,
  box,
}: {
  slash: SlashBox
  /** The box's text: what the hint goes after (the box itself still holds the old one while this draws). */
  text: string
  box: RefObject<HTMLTextAreaElement | null>
}) {
  const id = useSheetId()
  const t = useT()
  const menu = useRef<HTMLDivElement>(null)
  const { open, list, active, argument } = slash

  // The lit row in sight, as the arrows move it past the list's edge.
  useLayoutEffect(() => {
    if (!open) return
    const row = menu.current?.children[active] as HTMLElement | undefined
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  if (!open) return argument?.hint ? <ArgumentHint text={text} hint={argument.hint} box={box} /> : null
  return (
    // A press anywhere on it (a row, its padding, the keys line, its scrollbar) leaves the focus in the box.
    // biome-ignore lint/a11y/noStaticElementInteractions: it only keeps the focus where it is, it acts on nothing
    <div className="slash-menu" onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()}>
      <div className="slash-list" id={id(SLASH_MENU_ID)} role="listbox" aria-label={t('slash.label')} ref={menu}>
        {list.map((c, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the box's arrows, Tab and Enter pick (aria-activedescendant)
          // biome-ignore lint/a11y/useFocusableInteractive: as above: the focus stays in the box
          <div
            key={c.name}
            id={id(slashOptionId(i))}
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

/**
 * What a picked command takes, as grey text right after the caret ("/compact [instructions]"),
 * as Claude Code shows it in its own input: laid over the box in the box's own font, the typed
 * part kept invisible so the hint starts where the text ends.
 */
function ArgumentHint({ text, hint, box }: { text: string; hint: string; box: RefObject<HTMLTextAreaElement | null> }) {
  const ghost = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const b = box.current
    const g = ghost.current
    if (!b || !g) return
    const cs = getComputedStyle(b)
    Object.assign(g.style, {
      left: `${b.offsetLeft}px`,
      top: `${b.offsetTop}px`,
      width: `${b.clientWidth}px`,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
    })
  })
  return (
    <span className="slash-hint" aria-hidden="true" ref={ghost}>
      <span className="slash-typed">{text}</span>
      {hint}
    </span>
  )
}
