// Stop on a working session's card (#330): the first press arms it and it says so in red, a second
// one (not the second click of a double click) stops the turn; left alone, Escape, the pointer or
// the focus going elsewhere puts it back. Shown only where the board knows the program's interrupt
// key and its pane (core/turn-keys.ts canStop).
import { type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useState } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { useSessionActions } from '../hooks/useSessionActions.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { ARM_MS, pressStop } from '../models/stop-guard.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { classNames } from './class-names.ts'
import { StopGlyph } from './icons.tsx'

/**
 * A glyph among the card's hover buttons that says more only once armed. (In the sheet, Stop is the
 * message box's send button: sheet/SendButton.tsx, #340.)
 */
export function StopButton({ item }: { item: Item }) {
  const t = useT()
  const { canMutate, ui } = useBoardContext()
  const actions = useSessionActions()
  const [armedAt, setArmedAt] = useState<number | null>(null)
  const armed = armedAt !== null
  useEffect(() => {
    if (armedAt === null) return
    const id = setTimeout(() => setArmedAt(null), Math.max(0, ARM_MS - (Date.now() - armedAt)))
    return () => clearTimeout(id)
  }, [armedAt])
  const disarm = () => setArmedAt(null)
  return (
    <button
      type="button"
      data-act="stop"
      className={classNames('stop-turn', armed && 'armed')}
      title={t(armed ? 'turn.stop.confirmHint' : 'turn.stop.hint')}
      aria-label={armed ? t('turn.stop.confirmHint') : t('turn.stop')}
      // Not again while a stop of this session is on its way (its card says "Stopping…").
      disabled={!canMutate || ui.busy.has(item.key)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        // The card under it opens nothing (Board.tsx leaves data-act="stop" to this button).
        e.stopPropagation()
        const now = Date.now()
        const press = pressStop(armedAt, now, e.detail)
        if (press === 'arm') setArmedAt(now)
        else if (press === 'fire') {
          disarm()
          void actions.stopSession(item.key)
        }
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        // A held Enter repeats its click: it presses once.
        if (e.repeat && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault()
        if (e.key !== 'Escape' || !armed) return
        e.stopPropagation()
        disarm()
      }}
      onBlur={disarm}
      // A mouse that leaves takes the press back; a finger lifting leaves too, and keeps it.
      onPointerLeave={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === 'mouse') disarm()
      }}
    >
      <StopGlyph />
      {armed && <span className="stop-word">{t('turn.stop.confirmShort')}</span>}
    </button>
  )
}
