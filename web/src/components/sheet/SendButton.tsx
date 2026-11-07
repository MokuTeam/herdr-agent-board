// The message box's send button (#340). While the open session's turn runs and the box is empty it
// is Stop, as in any chat app: one press stops the turn (Esc through herdr, services/turn.ts, with
// its "did it stop" check and its toast); typed text, or the turn's end, makes it Send again. Where
// the board cannot stop the session (core/turn-keys.ts) it is the send button as it always was.
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { pressComposerStop } from '../../models/stop-guard.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SendIcon } from '../icons.tsx'

export interface SendButtonProps {
  /** The open session. */
  item: Item | null
  /** It is Stop now (models/composer.ts sendIsStop). */
  stop: boolean
  /** Send's own title, label and state, as the box has them. */
  title: string
  label: string
  disabled: boolean
  /** The focus into the message box. */
  focusBox: () => void
}

/** A touch screen: a focus moved into the box would pop its keyboard up. */
const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

export function SendButton({ item, stop, title, label, disabled, focusBox }: SendButtonProps) {
  const t = useT()
  const { canMutate, ui } = useBoardContext()
  const actions = useSessionActions()
  const button = useRef<HTMLButtonElement>(null)
  // The focus does not stay on Stop, where Space or Enter meant for the next message would press it:
  // into the box, where the next message is typed; on a touch screen just off the button.
  const offStop = () => {
    if (coarse()) button.current?.blur()
    else focusBox()
  }
  // When it turned into Stop: a press that soon is still the gesture that sent (stop-guard.ts). A
  // button clicked to send keeps the focus: it goes off it.
  const shownAt = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: turning into Stop is when to look, not a new focusBox
  useLayoutEffect(() => {
    if (!stop) return
    shownAt.current = Date.now()
    if (document.activeElement === button.current) offStop()
  }, [stop])
  return (
    <button
      ref={button}
      className={classNames('send', stop && 'stop')}
      type={stop ? 'button' : 'submit'}
      title={stop ? t('turn.stop.hint') : title}
      aria-label={stop ? t('turn.stop') : label}
      // Not again while a stop of this session is on its way (its card says "Stopping…").
      disabled={stop ? !canMutate || !item || ui.busy.has(item.key) : disabled}
      onClick={
        stop
          ? (e: MouseEvent<HTMLButtonElement>) => {
              if (!item || !pressComposerStop(shownAt.current, Date.now(), e.detail)) return
              offStop()
              void actions.stopSession(item.key)
            }
          : undefined
      }
      onKeyDown={
        stop
          ? (e: KeyboardEvent<HTMLButtonElement>) => {
              // A held Enter repeats its click: it presses once.
              if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
            }
          : undefined
      }
    >
      {/* The square is the button's own ::after (app.css), so the arrow and it cross-fade in place. */}
      <SendIcon />
    </button>
  )
}
