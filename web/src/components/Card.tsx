// A session's card: its name, age and alarm, what it works on, said or asks, its helpers at work
// and the sessions it works with, and its buttons. A session asleep in the idle column is one line.
// Motion and dragging are the board's (hooks/useFlip.ts, hooks/useCardDrag.ts); the card only says
// what it is. One asleep in "Waiting" folds down to its name, what it waits for and its time, and
// unfolds in place while pointed at, as the board's Settings say (hooks/useFold.ts, styles/fold.css).
import { type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, useRef } from 'react'
import { foldModeOf } from '../../../src/core/fold-mode.ts'
import type { Item, LaunchView, ToolCall } from '../../../src/core/types.ts'
import { useFold } from '../hooks/useFold.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { unseenResult } from '../models/attention.ts'
import {
  askLine,
  cardAge,
  cardWords,
  compact,
  dismissable,
  folds,
  inTurn,
  launchOf,
  questionLine,
} from '../models/card.ts'
import { pendingQuestions } from '../models/question-model.ts'
import { restartOf, restartView } from '../models/restart.ts'
import { COLUMN_COLORS } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { AlarmBadge } from './AlarmBadge.tsx'
import { classNames } from './class-names.ts'
import { HelpersChip, Relations } from './helpers/CardHelpers.tsx'
import {
  CheckGlyph,
  ClockGlyph,
  FocusGlyph,
  MoonGlyph,
  PinGlyph,
  RestartGlyph,
  SpinGlyph,
  StarGlyph,
  Turn,
  WriteGlyph,
} from './icons.tsx'
import { ProfileTag } from './ProfileTag.tsx'

/** What a session on its way shows on the board (hooks/useLaunch.ts). */
export interface LaunchSlots {
  /** The card of a launch that is not a session on the board yet. */
  card(item: Item): ReactNode
  /** How a session the board started goes, or why it failed, under its card. */
  note(launch: LaunchView): ReactNode
  /** A click on one of those lines' buttons; true when it was one. */
  onAction(e: MouseEvent<HTMLElement>): boolean
}

export interface CardProps {
  item: Item
  selected: boolean
  /** What is happening to it ("Waking…"), shown over the card. */
  busy: string | undefined
  /** Faded in its place while it is dragged and its ghost lands. */
  placeholder: boolean
  launch: LaunchSlots | undefined
  onPointerDown(e: PointerEvent<HTMLElement>): void
  onClick(e: MouseEvent<HTMLElement>): void
  onKeyDown(e: KeyboardEvent<HTMLElement>): void
  /** A session the card being pointed at works with. */
  related?: boolean
  /** Pointing at the card, or tabbing to it, marks the sessions it works with (null: none). */
  onRelated?: ((key: string | null) => void) | undefined
}

export function Card(props: CardProps) {
  const { item, selected, busy, placeholder, launch, onPointerDown, onClick, onKeyDown, onRelated } = props
  const { ui, data } = useBoardContext()
  const launchOnly = !!item.launchOnly
  const foldMode = foldModeOf(data?.foldWaiting)
  const folding = !launchOnly && foldMode !== 'off' && folds(item, data?.schedules)
  const ref = useRef<HTMLElement>(null)
  const fold = useFold(ref, folding, foldMode === 'over')
  const className = classNames(
    'card',
    launchOnly && 'launch-card',
    compact(item, data?.schedules) && 'compact',
    folding && 'folds',
    unseenResult(item, ui.viewed) && 'unseen',
    selected && 'selected',
    busy && 'busy',
    placeholder && 'placeholder',
    props.related && 'related',
  )
  return (
    <article
      ref={ref}
      className={className}
      data-key={item.key}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a card is focusable and opens with Enter, as before
      tabIndex={0}
      data-col={item.column}
      data-busy={busy}
      onPointerDown={(e: PointerEvent<HTMLElement>) => {
        fold.onPointerDown(e)
        onPointerDown(e)
      }}
      onClick={(e: MouseEvent<HTMLElement>) => {
        if (!fold.tookClick()) onClick(e)
      }}
      onKeyDown={onKeyDown}
      onPointerEnter={(e: PointerEvent<HTMLElement>) => {
        fold.onPointerEnter(e)
        if (e.pointerType === 'mouse') onRelated?.(item.key)
      }}
      onPointerLeave={(e: PointerEvent<HTMLElement>) => {
        fold.onPointerLeave(e)
        onRelated?.(null)
      }}
      onFocus={(e: FocusEvent<HTMLElement>) => {
        fold.onFocus(e)
        onRelated?.(item.key)
      }}
      onBlur={(e: FocusEvent<HTMLElement>) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        fold.onBlur()
        onRelated?.(null)
      }}
    >
      {launchOnly ? launch?.card(item) : <CardContent item={item} launch={launch} folding={folding} />}
    </article>
  )
}

function CardContent({ item, launch, folding }: { item: Item; launch: LaunchSlots | undefined; folding: boolean }) {
  const { data } = useBoardContext()
  const oneLine = compact(item, data?.schedules)
  return (
    <>
      <CardTop item={item} />
      {!oneLine && <CardBody item={item} launch={launch} folding={folding} />}
      <CardActions item={item} />
    </>
  )
}

function CardTop({ item }: { item: Item }) {
  const t = useT()
  const { ui, now } = useBoardContext()
  const age = cardAge(item, now, t)
  const renamed = item.name !== item.autoName && !!item.autoName
  return (
    <div className="card-top">
      {item.sleeping ? (
        <MoonGlyph />
      ) : (
        <span className={`dot ${item.column}`} style={{ '--c': COLUMN_COLORS[item.column] }} />
      )}
      <span className="name" title={renamed ? t('rename.was', { name: item.autoName }) : undefined}>
        {item.name}
      </span>
      {/* A favorite: a quiet star by the name. */}
      {item.favorite && (
        <span className="favorite" title={t('card.favorite')}>
          <StarGlyph />
        </span>
      )}
      {/* Its profile, while the board shows more than one, or one hidden or not known. */}
      <ProfileTag item={item} />
      <span className="card-status" style={{ '--c': COLUMN_COLORS[item.column] }} title={t(`col.${item.column}`)}>
        {t(`col.${item.column}`)}
      </span>
      {/* A result you have not opened yet: a dot by the name. */}
      {unseenResult(item, ui.viewed) && <span className="unseen-dot" title={t('attention.unseen')} />}
      {item.pin && item.pin === item.column && (
        <span className="pinned" title={t('card.pinned')}>
          <PinGlyph />
        </span>
      )}
      <AlarmBadge item={item} />
      <span className="age" title={age.title || undefined}>
        {age.text}
      </span>
    </div>
  )
}

/** Folded, what it waits for comes first and the rest under it, shown while it is open. */
function CardBody({ item, launch, folding }: { item: Item; launch: LaunchSlots | undefined; folding: boolean }) {
  const t = useT()
  const words = cardWords(item)
  const started = launchOf(item)
  const what = words.own ? (
    <div className="what">{words.own}</div>
  ) : words.asked ? (
    <div className="what">
      <span className="you">{t('card.you')}</span> {words.asked}
    </div>
  ) : null
  const wait = item.column === 'ext' && (
    <div className="chip">
      <ClockGlyph />
      <span>{item.wait || t('note.parked')}</span>
    </div>
  )
  if (folding)
    return (
      <>
        {wait}
        <div className="fold-more">
          {what}
          <CardRest item={item} launch={launch} />
        </div>
      </>
    )
  return (
    <>
      {what}
      {/* A launch held at the trust dialog says what it asks itself (its note), with its buttons. */}
      {item.column === 'me' && started?.state !== 'trust' && <CardAsk item={item} />}
      {wait}
      <CardRest item={item} launch={launch} />
    </>
  )
}

/** What it said last, what it runs, a restart, its helpers and partners, how its start goes. */
function CardRest({ item, launch }: { item: Item; launch: LaunchSlots | undefined }) {
  const words = cardWords(item)
  const started = launchOf(item)
  return (
    <>
      {words.said && <div className="said">{words.said}</div>}
      {item.column === 'work' && <Now tool={item.tool} />}
      <RestartLine item={item} />
      <HelpersChip item={item} />
      <Relations item={item} />
      {/* Started from the board and not done starting: how it goes, or why it failed. */}
      {started && launch?.note(started)}
    </>
  )
}

/** Under "Needs me": a question form's first question and options, else the question or the kind of stop. */
function CardAsk({ item }: { item: Item }) {
  const t = useT()
  const questions = pendingQuestions(item)
  if (questions) {
    const line = questionLine(questions, t)
    return (
      <div className="ask qa-card">
        <div className="qa-card-q">
          <b>{t('att.ask')}:</b> {line.header && <span className="qa-tag">{line.header}</span>}
          {line.question}
        </div>
        <div className="qa-card-opts">
          {line.options}
          {line.more && <span className="qa-more">{line.more}</span>}
        </div>
      </div>
    )
  }
  const ask = askLine(item, t)
  return (
    <div className="ask">
      <b>{ask.label}:</b> {ask.text}
    </div>
  )
}

/** Under "Working": the tool it runs, else that it thinks (after which tool). */
function Now({ tool }: { tool: ToolCall | null | undefined }) {
  const t = useT()
  if (tool?.pending)
    return (
      <div className="now">
        <SpinGlyph />
        <span className="tool">{tool.label}</span>
        <span className="detail">{tool.detail}</span>
      </div>
    )
  return (
    <div className="now idle">
      <SpinGlyph />
      <span className="tool">{t('card.thinking')}</span>
      {/* String(): a tool without a label read "undefined" before too. */}
      <span className="detail">{tool ? t('card.after', { tool: String(tool.label) }) : ''}</span>
    </div>
  )
}

/**
 * A restart on its way, on a card: a line like the one for the tool at work, quiet while it waits
 * for the session (and says on what), tinted with turning arrows while Claude exits and comes back.
 * The card stays whole meanwhile, also while the session is asleep for a moment (compact).
 */
function RestartLine({ item }: { item: Item }) {
  const t = useT()
  const { data } = useBoardContext()
  const e = restartOf(data?.schedules ?? [], item.key)
  if (!e) return null
  const view = restartView(e, t)
  return (
    <div className={classNames('now restart', view.on && 'on')}>
      <Turn>
        <RestartGlyph />
      </Turn>
      <span className="tool">{view.badge}</span>
      <span className="detail">{view.title}</span>
    </div>
  )
}

function CardActions({ item }: { item: Item }) {
  const t = useT()
  const { canMutate, canEdit } = useBoardContext()
  const q = (s: string) => t('q', { s })
  return (
    <div className="card-actions">
      {dismissable(item) && (
        <button
          type="button"
          data-act="dismiss"
          title={item.attention === 'later' ? t('card.seen', { col: q(t('col.me')) }) : t('card.noReply')}
          disabled={!canEdit}
        >
          <CheckGlyph />
        </button>
      )}
      {!item.sleeping && !!item.session && !inTurn(item) && (
        <button type="button" data-act="sleep" title={t('card.sleep')} disabled={!canMutate}>
          <MoonGlyph />
        </button>
      )}
      <button type="button" data-act="write" title={t('card.write')}>
        <WriteGlyph />
      </button>
      <button type="button" data-act="focus" title={t('card.focus')} disabled={!canMutate}>
        <FocusGlyph />
      </button>
    </div>
  )
}
