// The board: one lane per category, its cards in the columns. Every change of place animates
// with a spring from where the card was (useFlip), and a card can be dragged to another lane or
// column (useCardDrag); a click opens it, its buttons act on the session.
import { type KeyboardEvent, type MouseEvent, useRef } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useCardDrag } from '../hooks/useCardDrag.ts'
import { useFlip } from '../hooks/useFlip.ts'
import { useSessionActions } from '../hooks/useSessionActions.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { anyShown, dropTarget, lanesOf } from '../models/board-view.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Card, type LaunchSlots } from './Card.tsx'
import { Lane, type NewSessionContext } from './Lane.tsx'

export interface BoardProps {
  /** Opens the session in the sheet (Task 25); `compose`: with the message box ready. */
  onOpen?: (key: string, opts: { compose: boolean }) => void
  onNewSession?: (ctx: NewSessionContext, from: HTMLElement) => void
  /** Sessions on their way (Task 27). */
  launch?: LaunchSlots
  /** A card's key -> the launch card it takes over on screen (Task 27). */
  takeovers?: ReadonlyMap<string, string>
  /** The height of a panel docked at the bottom, which a drag scrolls above (Task 25). */
  roomBelow?: () => number
}

const actionOf = (e: MouseEvent<HTMLElement>): string | undefined =>
  e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]')?.dataset.act : undefined

export function Board({ onOpen, onNewSession, launch, takeovers, roomBelow }: BoardProps) {
  const t = useT()
  const { data, ui, canMutate, canEdit, dispatch } = useBoardContext()
  const { visible } = useBoardView()
  const actions = useSessionActions()
  const root = useRef<HTMLElement>(null)
  const lanes = data ? lanesOf(data, visible, ui.filter, ui.moves) : []
  const itemOf = (key: string): Item | undefined => data?.items.find(i => i.key === key)

  useFlip(
    root,
    lanes.flatMap(lane => lane.items.map(it => it.key)),
    takeovers,
  )
  const drag = useCardDrag({
    canEdit: () => canEdit,
    known: key => !!itemOf(key),
    targetAt: (key, place) => dropTarget(itemOf(key), ui.moves, place),
    onDrop: (key, target) => void actions.moveCard(key, target),
    roomBelow,
  })

  function open(key: string, compose = false): void {
    if (onOpen) onOpen(key, { compose })
    else dispatch({ type: 'open', key })
  }

  function onCardClick(e: MouseEvent<HTMLElement>, key: string): void {
    if (getSelection()?.isCollapsed === false) return
    if (drag.justDragged(key)) return
    // A starting session's own buttons; its card opens nothing.
    if (launch?.onAction(e) || !itemOf(key)) return
    const act = actionOf(e)
    if (act === 'focus') void actions.focusSession(key)
    else if (act === 'write') open(key, true)
    else if (act === 'dismiss') void actions.dismissAsk(key)
    else if (act === 'sleep') void actions.sleepSession(key)
    else open(key)
  }

  function onCardKey(e: KeyboardEvent<HTMLElement>, key: string): void {
    if (e.key === 'Enter' && e.target === e.currentTarget && itemOf(key)) open(key)
  }

  const renderCard = (it: Item) => (
    <Card
      key={it.key}
      item={it}
      selected={ui.open === it.key}
      busy={ui.busy.get(it.key)}
      placeholder={drag.placeholder === it.key}
      launch={launch}
      onPointerDown={e => drag.onPointerDown(e, it.key)}
      onClick={e => onCardClick(e, it.key)}
      onKeyDown={e => onCardKey(e, it.key)}
    />
  )

  return (
    <main className="board" id="board" ref={root}>
      {data && !anyShown(lanes) && <p className="empty">{t(data.items.length ? 'empty.none' : 'empty.noSessions')}</p>}
      {lanes.map(lane => (
        <Lane
          key={lane.id}
          lane={lane}
          lit={drag.lit}
          canMutate={canMutate}
          onNewSession={(ctx, from) => onNewSession?.(ctx, from)}
          renderCard={renderCard}
        />
      ))}
    </main>
  )
}
