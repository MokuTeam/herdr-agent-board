import { useState } from 'react'
import { type CardWindowKind, type CardWindowView, readCardWindow, saveCardWindow } from '../models/card-window.ts'
import { PHONE_QUERY } from '../models/panel-motion.ts'
import { useMediaQuery } from './useMediaQuery.ts'

export function useCardWindow(kind: CardWindowKind | undefined) {
  const phone = useMediaQuery(kind ? PHONE_QUERY : null)
  const [choices, setChoices] = useState<Partial<Record<CardWindowKind, CardWindowView>>>({})
  if (!kind) return undefined
  const view = readCardWindow(kind, choices[kind])
  return {
    view: phone ? (kind === 'terminal' ? 'modal' : 'panel') : view,
    toggle: phone
      ? undefined
      : () => {
          const next = view === 'modal' ? 'panel' : 'modal'
          saveCardWindow(kind, next)
          setChoices(previous => ({ ...previous, [kind]: next }))
        },
  }
}
