// A session's card: its name, age and alarm, what it works on, said or asks, its helpers at work
// and the sessions it works with, and its buttons. A session asleep in the idle column is one line.
// Motion and dragging are the board's (hooks/useFlip.ts, hooks/useCardDrag.ts); the card only says
// what it is. One asleep in "Waiting" folds down to its name, what it waits for and its time, and
// unfolds in place while pointed at, as the board's Settings say (hooks/useFold.ts, styles/fold.css).
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useRef,
} from 'react'
import { foldModeOf } from '../../../src/core/fold-mode.ts'
import { canStop } from '../../../src/core/turn-keys.ts'
import type { Item, LaunchView, ToolCall } from '../../../src/core/types.ts'
import { useDecisions } from '../hooks/useDecisions.ts'
import { useFold } from '../hooks/useFold.ts'
import { useHeadFit } from '../hooks/useHeadFit.ts'
import { useWordClip } from '../hooks/useWordClip.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { unseenResult } from '../models/attention.ts'
import { type CallLines as CallView, callLines, inMokupilot } from '../models/call.ts'
import {
  ago,
  askLine,
  type CardBgTask,
  type CardChecklist,
  type CardWords,
  cardAge,
  cardBgTask,
  cardChecklist,
  cardMeter,
  cardWords,
  compact,
  dismissable,
  folds,
  inTurn,
  launchOf,
  plain,
  questionLine,
} from '../models/card.ts'
import { nameParts } from '../models/card-head.ts'
import { nodeLook, nodeOffline } from '../models/devices.ts'
import { pendingQuestions } from '../models/question-model.ts'
import { restartOf, restartView } from '../models/restart.ts'
import { COLUMN_COLORS } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { AlarmBadge } from './AlarmBadge.tsx'
import { classNames } from './class-names.ts'
import { DecisionButtons } from './decisions/DecisionButtons.tsx'
import { CardIdentity } from './devices/DeviceChip.tsx'
import { HelpersChip, Relations } from './helpers/CardHelpers.tsx'
import {
  CheckGlyph,
  ClockGlyph,
  FocusGlyph,
  MoonGlyph,
  PhoneGlyph,
  PinGlyph,
  RestartGlyph,
  SpinGlyph,
  StarGlyph,
  Turn,
  WriteGlyph,
} from './icons.tsx'
import { ModelTag } from './ModelTag.tsx'
import { ProfileTag } from './ProfileTag.tsx'
import { ProviderMark } from './ProviderMark.tsx'
import { StopButton } from './StopButton.tsx'
import { CardThreadChips, KeyText } from './threads/bits.tsx'
import { WatchLine } from './WatchLine.tsx'

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
    // An offline device's card (#502): its last one, greyed (nodes.css).
    nodeOffline(item, data?.devices) && 'node-offline',
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
  const t = useT()
  const { data } = useBoardContext()
  const oneLine = compact(item, data?.schedules)
  const checklist = !oneLine && !folding ? cardChecklist(item, t) : null
  return (
    <>
      <CardTop item={item} />
      {/* A card of another device (#502): its identity row with the device; none for this computer's. */}
      <CardIdentity item={item} />
      {item.agent === 'codex' && item.model && item.effort && (
        <div className="card-meter">
          {item.model} · {item.effort}
        </div>
      )}
      {!oneLine && <CardBody item={item} launch={launch} folding={folding} />}
      <CardActions item={item} />
      {checklist && <ChecklistEdge checklist={checklist} />}
    </>
  )
}

/** Quiet 2px progress line along the card's bottom edge (#637); full list in native tooltip. */
function ChecklistEdge({ checklist }: { checklist: CardChecklist }) {
  return (
    <div
      className="card-todo-track"
      role="progressbar"
      aria-label={checklist.ariaLabel}
      aria-valuemin={0}
      aria-valuemax={checklist.total}
      aria-valuenow={checklist.done}
    >
      <div className="card-todo-fill" style={{ width: `${checklist.pct}%` }} />
    </div>
  )
}

function CardTop({ item }: { item: Item }) {
  const t = useT()
  const { ui, now } = useBoardContext()
  const age = cardAge(item, now, t)
  const renamed = item.name !== item.autoName && !!item.autoName
  const was = renamed ? t('rename.was', { name: item.autoName }) : undefined
  return (
    <div className="card-top">
      {item.sleeping ? (
        <MoonGlyph />
      ) : (
        <span className={`dot ${item.column}`} style={{ '--c': COLUMN_COLORS[item.column] }} />
      )}
      <ProviderMark item={item} />
      <CardName name={item.name} was={was} />
      {/* A favorite: a quiet star by the name. */}
      {item.favorite && (
        <span className="favorite" title={t('card.favorite')}>
          <StarGlyph />
        </span>
      )}
      {/* Its profile, while the board shows more than one, or one hidden or not known. */}
      <ProfileTag item={item} mark />
      {/* Another model than config.json's `models` expects (#429). */}
      <ModelTag item={item} />
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

/**
 * A card's name, which wins its row: the rest of the row gives way first (useHeadFit). Whether it
 * is cut even so is the name's alone, so a change of it draws the name again, not the row.
 */
function CardName({ name, was }: { name: string; was: string | undefined }) {
  const ref = useRef<HTMLSpanElement>(null)
  const cut = useHeadFit(ref)
  return <NameText ref={ref} name={name} cut={cut} was={was} />
}

/**
 * A card's name, one text as before while it shows whole. Cut even so (`cut`), it is whole in its
 * tooltip, and one whose end tells it apart is drawn in two parts, so the cut falls before that
 * end (models/card-head.ts nameParts). The two parts are what shows; the name is read, found and
 * copied whole, from a copy of it out of sight. `was`: the name the session had before a rename.
 */
export function NameText({
  ref,
  name,
  cut,
  was,
}: {
  ref?: Ref<HTMLSpanElement>
  name: string
  cut: boolean
  was: string | undefined
}) {
  const parts = cut ? nameParts(name) : null
  const title = cut ? [name, was].filter(Boolean).join('\n') : was
  if (!parts)
    return (
      <span ref={ref} className="name" title={title}>
        {name}
      </span>
    )
  return (
    <span ref={ref} className="name split" title={title}>
      <span className="sr-only">{name}</span>
      <span className="name-head" aria-hidden="true">
        {parts.head}
      </span>
      <span className="name-tail" aria-hidden="true">
        {parts.tail}
      </span>
    </span>
  )
}

/** Folded, what it waits for comes first and the rest under it, shown while it is open. */
function CardBody({ item, launch, folding }: { item: Item; launch: LaunchSlots | undefined; folding: boolean }) {
  const t = useT()
  const words = cardWords(item)
  const started = launchOf(item)
  const checklist = cardChecklist(item, t)
  const explicitDoing = !!plain(item.doing)
  const stepDiffers = !!checklist?.current && plain(words.own) !== checklist.current
  const inlineChecklist = checklist && (
    <>
      <span className="card-todo-ratio">{checklist.ratio}</span>
      {checklist.current && (!explicitDoing || stepDiffers) && (
        <>
          <span className="card-todo-sep" aria-hidden="true">
            {' · '}
          </span>
          <span className="card-todo-step">{checklist.current}</span>
        </>
      )}
    </>
  )
  const what = words.recap ? (
    <RecapLine item={item} words={words} checklist={checklist} />
  ) : explicitDoing ? (
    <div className="what" title={checklist?.tooltip}>
      {checklist && (
        <>
          <span className="card-todo-ratio">{checklist.ratio}</span>
          <span className="card-todo-sep" aria-hidden="true">
            {' · '}
          </span>
        </>
      )}
      <KeyText text={words.own} />
      {checklist && stepDiffers && (
        <>
          <span className="card-todo-sep" aria-hidden="true">
            {' · '}
          </span>
          <span className="card-todo-step">{checklist.current}</span>
        </>
      )}
    </div>
  ) : checklist ? (
    <div className="what" title={checklist.tooltip}>
      {inlineChecklist}
    </div>
  ) : words.own ? (
    <div className="what">
      <KeyText text={words.own} />
    </div>
  ) : words.asked ? (
    <div className="what">
      <span className="you">{t('card.you')}</span> {words.asked}
    </div>
  ) : null
  const wait = item.column === 'ext' && (
    <>
      <div className="chip">
        <ClockGlyph />
        <span>{item.wait || t('note.parked')}</span>
      </div>
      {/* Watches (#486): how its probe stands; nothing without one. */}
      <WatchLine item={item} />
    </>
  )
  if (folding)
    return (
      <>
        {wait}
        <div className="fold-more">
          {what}
          <CardThreadChips session={item.key} />
          <CardRest item={item} launch={launch} />
        </div>
      </>
    )
  return (
    <>
      {item.call ? <CallParts item={item}>{what}</CallParts> : what}
      {/* Threads (#392): the session's open threads as chips; nothing for a session with none. */}
      <CardThreadChips session={item.key} />
      {/* A launch held at the trust dialog says what it asks itself (its note), with its buttons. */}
      {item.column === 'me' && started?.state !== 'trust' && <CardAsk item={item} />}
      {wait}
      <CardRest item={item} launch={launch} />
    </>
  )
}

/**
 * Claude Code's recap as the card's line (#321): how long ago it was written, quietly before it;
 * set back a shade once the session has gone on long after it. The task it stands over under it,
 * in one line. Both end at a word.
 */
function RecapLine({ item, words, checklist }: { item: Item; words: CardWords; checklist: CardChecklist | null }) {
  const t = useT()
  const { now } = useBoardContext()
  const line = useRef<HTMLDivElement>(null)
  const task = useRef<HTMLDivElement>(null)
  const recap = useWordClip(line, words.recap)
  const doing = useWordClip(task, words.task)
  const age = ago(item.recapAt, now, t)
  return (
    <>
      <div
        ref={line}
        className={classNames('what recap', words.stale && 'stale')}
        title={
          recap === words.recap
            ? checklist?.tooltip
            : checklist
              ? `${words.recap}\n\n${checklist.tooltip}`
              : words.recap
        }
      >
        <span className="sr-only">{`${t('card.recap')}: `}</span>
        {age && (
          <span className="recap-age" title={t('card.recapAge')}>
            {age}
          </span>
        )}
        {age && ' '}
        {checklist && !words.task && (
          <>
            <span className="card-todo-ratio">{checklist.ratio}</span>{' '}
          </>
        )}
        <span data-clip="">{recap}</span>
      </div>
      {words.task && (
        <div ref={task} className="task" title={checklist?.tooltip ?? (doing === words.task ? undefined : words.task)}>
          <span className="task-label">{t('row.task')}</span>{' '}
          {checklist && (
            <>
              <span className="card-todo-ratio">{checklist.ratio}</span>{' '}
            </>
          )}
          <span data-clip="">{doing}</span>
        </div>
      )}
    </>
  )
}

/** What it said last, what it runs, a restart, its helpers and partners, how its start goes. */
function CardRest({ item, launch }: { item: Item; launch: LaunchSlots | undefined }) {
  const t = useT()
  const { now } = useBoardContext()
  const words = cardWords(item)
  const started = launchOf(item)
  const bgTask = cardBgTask(item, now, t)
  return (
    <>
      {words.said && <div className="said">{words.said}</div>}
      {item.column === 'work' ? (
        item.tool?.pending ? (
          <>
            <Now tool={item.tool} />
            {bgTask && <BgTaskLine task={bgTask} />}
          </>
        ) : bgTask ? (
          <BgTaskLine task={bgTask} />
        ) : (
          <Now tool={item.tool} />
        )
      ) : (
        bgTask && <BgTaskLine task={bgTask} />
      )}
      <RestartLine item={item} />
      <HelpersChip item={item} />
      <Relations item={item} />
      <MeterLine item={item} />
      {/* Started from the board and not done starting: how it goes, or why it failed. */}
      {started && launch?.note(started)}
    </>
  )
}

/** Active or potentially stuck background task line on a card (#676). */
function BgTaskLine({ task }: { task: CardBgTask }) {
  return (
    <div className={classNames('now bg-task', task.stuck && 'stuck')} title={task.tooltip}>
      {task.stuck ? <ClockGlyph /> : <SpinGlyph />}
      <span className="tool">{task.label}</span>
      {task.detail && <span className="detail">{task.detail}</span>}
    </div>
  )
}

/**
 * A Claude session's context and effort (#193), quietly at the card's foot: "85k / 200k (42%) ·
 * Effort high", either part alone when only one is known, nothing when neither is or for another
 * agent (models/card.ts cardMeter).
 */
function MeterLine({ item }: { item: Item }) {
  const t = useT()
  const meter = cardMeter(item, t)
  if (!meter) return null
  return (
    <div className="card-meter">
      <div className="meter-row">
        {meter.context && (
          <span className={classNames('meter-ctx', meter.tone)} title={t('card.contextHint')}>
            {meter.context}
          </span>
        )}
        {meter.effort && (
          <span className="meter-effort" title={t('meter.effortHint')}>
            {meter.effort}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A MokuPilot call agent's card (#326): its call first under its name (on a call and for how long,
 * or how many helpers it finishes after the call), a line like the tool at work, quiet and still;
 * then the card's own line (`children`); then its task board as task lines.
 */
function CallParts({ item, children }: { item: Item; children: ReactNode }) {
  const t = useT()
  const { now } = useBoardContext()
  const call = callLines(item, now, t)
  if (!call) return children
  return (
    <>
      <CallLine call={call} />
      {children}
      {call.rows.map(row => (
        <div key={row.id} className={classNames('task call-task', row.kind)} title={row.text}>
          <span className="task-label">{row.label}</span> {row.text}
          {row.steps && <span className="call-steps"> {row.steps}</span>}
          {row.more && <span className="call-more"> {row.more}</span>}
        </div>
      ))}
    </>
  )
}

function CallLine({ call }: { call: CallView }) {
  return (
    <div className={classNames('now call', call.phase === 'after' && 'after')} title={call.hint}>
      <PhoneGlyph />
      <span className="tool">{call.label}</span>
      {call.detail && <span className="detail">{call.detail}</span>}
    </div>
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
    <>
      <div className="ask">
        <b>{ask.label}:</b> {ask.text}
      </div>
      {/* Decisions (#487): its options, the default and Hold; nothing for an ask without them. */}
      {item.decision && <CardDecision item={item} />}
    </>
  )
}

/** A question's options on its card (#487). */
function CardDecision({ item }: { item: Item }) {
  const decisions = useDecisions()
  const d = item.decision
  if (!d) return null
  return (
    <DecisionButtons
      inCard
      decisions={decisions}
      choice={{
        sessionKey: item.key,
        id: d.id,
        options: d.options,
        recommend: d.recommend,
        defaultAt: d.defaultAt,
        held: d.held !== undefined,
      }}
    />
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
  const { canMutate, canEdit, data, now } = useBoardContext()
  const q = (s: string) => t('q', { s })
  // A MokuPilot call agent (#326) runs in MokuPilot, not in a pane: nothing to focus, put to sleep
  // or type into from the board.
  const away = inMokupilot(item)
  // A card of another device (#502): its herdr pane is not on this computer, so no Go to herdr;
  // while the master does not hear the device, what goes there answers that it is not reachable.
  const why = item.device ? nodeLook(item, data?.devices, now, t)?.why || undefined : undefined
  return (
    <div className="card-actions">
      {/* Its turn interrupted with its program's own key, where the board knows it (#330). */}
      {canStop(item) && !away && <StopButton item={item} />}
      {dismissable(item) && (
        <button
          type="button"
          data-act="dismiss"
          title={why ?? (item.attention === 'later' ? t('card.seen', { col: q(t('col.me')) }) : t('card.noReply'))}
          disabled={!canEdit || !!why}
        >
          <CheckGlyph />
        </button>
      )}
      {!item.sleeping && !!item.session && !inTurn(item) && !away && (
        <button type="button" data-act="sleep" title={why ?? t('card.sleep')} disabled={!canMutate || !!why}>
          <MoonGlyph />
        </button>
      )}
      {/* A day session (#331) takes messages: MokuPilot types its day's inbox into it. */}
      {(!away || item.day) && (
        <button type="button" data-act="write" title={t('card.write')}>
          <WriteGlyph />
        </button>
      )}
      {!away && !item.device && (
        <button type="button" data-act="focus" title={t('card.focus')} disabled={!canMutate}>
          <FocusGlyph />
        </button>
      )}
    </div>
  )
}
