// A question's options as buttons (#487): on the card, in the session's sheet and in the Decisions
// panel. A click types the option into the session (hooks/useDecisions.ts); the recommended one is
// marked; under them when the default goes, or that it is held, and Hold while it runs. On a card
// the buttons keep the click, the press and the keys to themselves: the card under them opens
// nothing and starts no drag.
import { type KeyboardEvent, type MouseEvent, type PointerEvent, useState } from 'react'
import type { DecisionsUi } from '../../hooks/useDecisions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { defaultText } from '../../models/decisions.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'

export interface DecisionChoice {
  /** The session's card key. */
  sessionKey: string
  id: string
  options: readonly string[]
  /** 1-based; null or absent: none. */
  recommend?: number | null | undefined
  defaultAt?: number | null | undefined
  held: boolean
}

/** Keeps an event from the card under the buttons. */
const own = (e: MouseEvent | PointerEvent | KeyboardEvent): void => e.stopPropagation()

export function DecisionButtons({
  choice,
  decisions,
  inCard = false,
}: {
  choice: DecisionChoice
  decisions: DecisionsUi
  inCard?: boolean
}) {
  const t = useT()
  const { now, canMutate, canEdit } = useBoardContext()
  // One answer at a time: the buttons rest while one is on its way.
  const [sending, setSending] = useState(false)
  const { sessionKey, id, options, recommend, held } = choice
  const defaultAt = choice.defaultAt ?? undefined
  const line = defaultText({ ...(defaultAt !== undefined && { defaultAt }), ...(held && { held: 1 }) }, now, t)
  const keep = inCard ? { onPointerDown: own, onKeyDown: own } : {}

  async function pick(n: number, e: MouseEvent): Promise<void> {
    if (inCard) e.stopPropagation()
    setSending(true)
    await decisions.answer(sessionKey, id, { option: n })
    setSending(false)
  }

  async function hold(e: MouseEvent): Promise<void> {
    if (inCard) e.stopPropagation()
    await decisions.hold(sessionKey, id)
  }

  return (
    <div className={classNames('dec-choice', inCard && 'in-card')}>
      {options.length > 0 && (
        <div className="dec-options">
          {options.map((o, i) => {
            const n = i + 1
            const rec = recommend === n
            return (
              <button
                key={o}
                type="button"
                className={classNames('mini dec-option', rec && 'recommended')}
                data-act="decision"
                disabled={!canMutate || sending}
                title={rec ? t('dec.recommended') : undefined}
                onClick={e => void pick(n, e)}
                {...keep}
              >
                <span>{o}</span>
                {rec && <span className="dec-rec">{t('dec.recommended')}</span>}
              </button>
            )
          })}
        </div>
      )}
      {line && (
        <div className="dec-default">
          <span className={classNames('dec-when', held && 'held')}>{line}</span>
          {defaultAt !== undefined && !held && (
            <button
              type="button"
              className="mini dec-hold"
              data-act="decision-hold"
              disabled={!canEdit}
              title={t('dec.holdHint')}
              onClick={e => void hold(e)}
              {...keep}
            >
              {t('dec.hold')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The owner's own words for a question: a field and Send. */
export function OwnAnswer({ onSend }: { onSend(text: string): Promise<boolean> }) {
  const t = useT()
  const { canMutate } = useBoardContext()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  async function send(): Promise<void> {
    const words = text.trim()
    if (!words) return
    setSending(true)
    if (await onSend(words)) setText('')
    setSending(false)
  }
  return (
    <form
      className="dec-own"
      onSubmit={e => {
        e.preventDefault()
        void send()
      }}
    >
      <input
        type="text"
        value={text}
        placeholder={t('dec.own')}
        aria-label={t('dec.own')}
        onChange={e => setText(e.target.value)}
      />
      <button type="submit" className="mini" disabled={!canMutate || sending || !text.trim()}>
        {t('dec.send')}
      </button>
    </form>
  )
}
