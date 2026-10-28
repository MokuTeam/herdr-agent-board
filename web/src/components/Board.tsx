// The board: one lane per category, its cards in the columns. Every change of place animates
// with a spring from where the card was (useFlip), and a card can be dragged to another lane or
// column (useCardDrag); a click opens it, its buttons act on the session. Pointing at a card marks
// the sessions it works with. A card back from the archive comes out of the Archive button.
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { type Archive, flyFromArchive } from '../hooks/useArchive.ts'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useCardDrag } from '../hooks/useCardDrag.ts'
import { useFlip } from '../hooks/useFlip.ts'
import { useGoToSession } from '../hooks/useGoToSession.ts'
import { useSessionActions } from '../hooks/useSessionActions.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { dropWhy } from '../models/archive-drop.ts'
import { anyShown, dropTarget, lanesOf } from '../models/board-view.ts'
import { relatedKeys } from '../models/helper-model.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Card, type LaunchSlots } from './Card.tsx'
import { DropArchive } from './DropArchive.tsx'
import { Lane, type NewSessionContext } from './Lane.tsx'

export interface BoardProps {
  /** Opens a session when not in the sheet as by default; `compose`: with the message box ready. */
  onOpen?: (key: string, opts: { compose: boolean }) => void
  onNewSession?: (ctx: NewSessionContext, from: HTMLElement) => void
  /** A lane's head: the categories panel, at that lane. */
  onLaneHead?: (id: string) => void
  /** A lane's day total (#233): the Time panel on that client. */
  onLaneTime?: (id: string) => void
  /** Sessions on their way (hooks/useLaunch.ts). */
  launch?: LaunchSlots
  /** A card's key -> the launch card it takes over on screen. */
  takeovers?: ReadonlyMap<string, string>
  /** The height of a panel docked at the bottom, which a drag scrolls above (Task 25). */
  roomBelow?: () => number
  /** The archive: a card dragged onto its place, which comes up with the drag, goes there. */
  archive?: Pick<Archive, 'archiveSession'>
}

const buttonOf = (e: MouseEvent<HTMLElement>): HTMLElement | null | undefined =>
  e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : undefined

export function Board({
  onOpen,
  onNewSession,
  onLaneHead,
  onLaneTime,
  launch,
  takeovers,
  roomBelow,
  archive,
}: BoardProps) {
  const t = useT()
  const { data, ui, canMutate, canEdit, dispatch, toast } = useBoardContext()
  const { visible } = useBoardView()
  const actions = useSessionActions()
  const goToSession = useGoToSession()
  const root = useRef<HTMLElement>(null)
  const dropPlace = useRef<HTMLDivElement>(null)
  const lanes = data ? lanesOf(data, visible, ui.filter, ui.moves) : []
  const itemOf = (key: string): Item | undefined => data?.items.find(i => i.key === key)
  // The card whose sessions are marked; a card no longer on show marks none.
  const [relatedTo, setRelatedTo] = useState<string | null>(null)
  const onShow = relatedTo !== null && lanes.some(lane => lane.items.some(it => it.key === relatedTo))
  useEffect(() => {
    if (relatedTo !== null && !onShow) setRelatedTo(null)
  }, [relatedTo, onShow])
  const related = onShow && relatedTo !== null ? relatedKeys(itemOf(relatedTo)) : new Set<string>()

  useFlip(
    root,
    lanes.flatMap(lane => lane.items.map(it => it.key)),
    takeovers,
    (key, el) => {
      if (!ui.flyBack.has(key)) return false
      flyFromArchive(el)
      dispatch({ type: 'flewBack', key })
      return true
    },
  )
  const drag = useCardDrag({
    canEdit: () => canEdit,
    known: key => !!itemOf(key),
    targetAt: (key, place) => dropTarget(itemOf(key), ui.moves, place),
    onDrop: (key, target) => void actions.moveCard(key, target),
    roomBelow,
    // Into the archive as "Archive" in the card's menu takes it; the card went into the place on its own.
    archive: archive && {
      place: () => dropPlace.current,
      why: key => dropWhy(itemOf(key), data?.schedules ?? [], canMutate, canEdit),
      onDrop: key => void archive.archiveSession(key, { fly: false }),
      onRefused: why => toast(t(why), true),
    },
  })

  function open(key: string, compose = false): void {
    if (onOpen) onOpen(key, { compose })
    else dispatch({ type: 'open', key, compose })
  }

  function onCardClick(e: MouseEvent<HTMLElement>, key: string): void {
    if (getSelection()?.isCollapsed === false) return
    if (drag.justDragged(key)) return
    // A starting session's own buttons; its card opens nothing.
    if (launch?.onAction(e) || !itemOf(key)) return
    const button = buttonOf(e)
    const act = button?.dataset.act
    if (act === 'focus') void actions.focusSession(key)
    else if (act === 'write') open(key, true)
    else if (act === 'dismiss') void actions.dismissAsk(key)
    else if (act === 'sleep') void actions.sleepSession(key)
    else if (act === 'rel') goToSession(button?.dataset.key ?? '')
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
      related={related.has(it.key)}
      onRelated={setRelatedTo}
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
          onHead={() => onLaneHead?.(lane.id)}
          time={data?.time?.today[lane.id]}
          onTime={() => onLaneTime?.(lane.id)}
          renderCard={renderCard}
        />
      ))}
      {archive && <DropArchive view={drag.archive} placeRef={dropPlace} />}
    </main>
  )
}
