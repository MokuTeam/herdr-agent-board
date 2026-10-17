// The session sheet: the session panel with the open session's head, its card fields, what it asks,
// the conversation and the message box. It opens for a card (the board's `open`, "Write" with the
// message box ready); a click on another card switches it to that session, and while it slides
// out it keeps showing the last one. Files dropped anywhere on the panel go with the message.
//
// Parts the page hands in plug in here: the question form or permission prompt, the file chips and
// quick looks, the reminders' buttons (the page's schedule desk, shared with the schedule panel);
// the phone's "More actions" menu and renaming; "New here" opens the launch window.
import { type ReactNode, type Ref, useLayoutEffect, useRef, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import type { SessionDetail } from '../../api/client.ts'
import { type ComposerControls, useComposer } from '../../hooks/useComposer.ts'
import { useFileDrop } from '../../hooks/useFileDrop.ts'
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import { type OpenLaunch, useNewSession } from '../../hooks/useNewSession.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { type DetailSnapshot, useSessionDetail } from '../../hooks/useSessionDetail.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { inTurn } from '../../models/card.ts'
import { PHONE_QUERY } from '../../models/panel-motion.ts'
import {
  askedView,
  detailNotice,
  headButtons,
  NO_HEAD_BUTTONS,
  sessionMissing,
  sheetAvailability,
  threadPlaceholder,
} from '../../models/sheet.ts'
import { reducedMotion } from '../../models/spring.ts'
import { termButton } from '../../models/terminal.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { CheckGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { Composer, type SessionButtons } from './Composer.tsx'
import type { ScheduleActions } from './ScheduleRow.tsx'
import { SheetCard } from './SheetCard.tsx'
import { SheetHead } from './SheetHead.tsx'
import { Thread } from './Thread.tsx'

/** What later tasks hand the sheet. */
export interface SheetSlots {
  /**
   * The question form or permission prompt the session waits on, drawn in #sheet-question in place
   * of what it asks (the terminal's screen then folds away under it); nothing when it has none (25c).
   */
  question?: ((item: Item, detail: SessionDetail | null) => ReactNode) | undefined
  /** After the conversation is drawn: its paths (data-path) become file chips (25c, files.upgrade). */
  upgradeFiles?: ((body: HTMLElement, cwd: string) => void) | undefined
  /** The quick look of the checkout's changes, opened from `button` (25c). */
  onChanges?: ((key: string, button: HTMLElement) => void) | undefined
  /** The quick look of the project's past sessions, opened from `button` (25c). */
  onHistory?: ((key: string, cwd: string, button: HTMLElement) => void) | undefined
  /** The reminders' buttons: cancel, delivery, "+2 more" (hooks/useSchedule.ts). */
  schedule?: ScheduleActions | undefined
  /** The phone's menu of the session's buttons, from "More actions" (`keyboard`: pressed by keys). */
  onMore?: ((button: HTMLElement, keyboard: boolean) => void) | undefined
  /** That menu is the one open ("More actions" says it is expanded). */
  moreOpen?: boolean | undefined
  /** Rename where the name is, in the head (hooks/useRenameInPlace.ts). */
  onRename?: ((key: string, name: HTMLElement) => void) | undefined
  /** "New here": the launch window, from the button (without fresh data, the toast that says why). */
  onNewSession?: OpenLaunch | undefined
  /** "Terminal": the terminal window of the session, from the button (hooks/useTerminal.ts). */
  onTerminal?: ((key: string, button: HTMLElement) => void) | undefined
}

/** The board's card of `key` (a drag's ghost is outside the board). */
function cardOf(key: string | null): HTMLElement | null {
  if (!key) return null
  const cards = document.getElementById('board')?.querySelectorAll<HTMLElement>('.card[data-key]') ?? []
  return [...cards].find(card => card.dataset.key === key) ?? null
}

/** The open session, else the one the sheet showed last (it keeps showing while it slides out). */
function useShown(open: string | null, item: Item | undefined): { key: string | null; item: Item | null } {
  const [kept, setKept] = useState<Item | null>(null)
  const [lastKey, setLastKey] = useState(open)
  if (open !== null && open !== lastKey) setLastKey(open)
  if (item && item !== kept) setKept(item)
  const key = open ?? lastKey
  return { key, item: item ?? (kept?.key === key ? kept : null) }
}

export function Sheet(slots: SheetSlots) {
  const { question, upgradeFiles, onChanges, onHistory, onMore, onRename, onNewSession, onTerminal } = slots
  const t = useT()
  const { data, ui, dispatch } = useBoardContext()
  const actions = useSessionActions()
  const fallbackNewSession = useNewSession()
  const newSession = onNewSession ?? fallbackNewSession
  const open = ui.open
  const itemOf = (key: string | null) => (key ? data?.items.find(i => i.key === key) : undefined)
  const shown = useShown(open, itemOf(open))
  const detail = useSessionDetail(shown.key)
  const composer = useComposer(detail.load)
  const drop = useFileDrop(composer.addFiles)
  const narrow = useMediaQuery(PHONE_QUERY)
  const body = useRef<HTMLDivElement>(null)

  // The card's details fold up on a phone; each session opens with them folded.
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  // Switching sessions in the open panel: its conversation fades in; it starts at the bottom.
  const before = useRef(open)
  useLayoutEffect(() => {
    const previous = before.current
    before.current = open
    if (open === null) return
    setPropertiesOpen(false)
    if (previous !== null && previous !== open && !reducedMotion.matches)
      body.current?.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
  }, [open])
  const stick = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: an opening is when to go to the bottom
  useLayoutEffect(() => {
    stick.current = true
  }, [open, ui.opened])
  // After every draw: at the bottom it stays at the bottom.
  useLayoutEffect(() => {
    const el = body.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  const cwd = shown.item?.cwd ?? ''
  const drawn = shown.item !== null
  // The conversation drawn anew (a new detail, the session shown, the language): its paths are new.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to look, not what it reads
  useLayoutEffect(() => {
    if (body.current && drawn) upgradeFiles?.(body.current, cwd)
  }, [detail.value.data, drawn, shown.key, cwd, t, upgradeFiles])

  const at = (act: (key: string) => unknown) => () => void (open && act(open))
  const item = itemOf(open)
  const buttons: SessionButtons = {
    focus: at(actions.focusSession),
    terminal: button => open && onTerminal?.(open, button),
    wake: at(actions.wakeSession),
    sleep: at(actions.sleepSession),
    changes: button => open && onChanges?.(open, button),
    history: button => open && onHistory?.(open, item?.cwd ?? '', button),
    newHere: button => open && newSession(item ? { item } : {}, button),
    more: (button, keyboard) => onMore?.(button, keyboard),
  }
  return (
    <Panel
      id="sheet"
      kind="session"
      open={open !== null}
      onClose={() => dispatch({ type: 'open', key: null })}
      about={() => cardOf(open)}
      className={drop.dropping ? 'dropping' : undefined}
      drop={drop.handlers}
      title={
        <SheetHead
          item={shown.item}
          missing={sessionMissing(shown.key, !!itemOf(shown.key), detail.value.status)}
          onRename={name => open && onRename?.(open, name)}
        />
      }
    >
      <SheetView
        open={open}
        item={shown.item}
        detail={detail.value}
        form={shown.item ? question?.(shown.item, detail.value.data) : null}
        narrow={narrow}
        propertiesOpen={propertiesOpen}
        onProperties={() => setPropertiesOpen(was => !was)}
        composer={composer}
        bodyRef={body}
        onBodyScroll={() => {
          const el = body.current
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        onRetry={() => open && detail.load(open)}
        onDismiss={at(actions.dismissAsk)}
        buttons={buttons}
        schedule={slots.schedule}
        moreOpen={slots.moreOpen ?? false}
      />
    </Panel>
  )
}

export interface SheetViewProps {
  /** The open session; null once the sheet closed (it keeps showing `item`). */
  open: string | null
  item: Item | null
  detail: DetailSnapshot
  /** The form the session waits on, in place of what it asks (SheetSlots.question). */
  form?: ReactNode
  /** A phone: the card's details fold up behind "Card details". */
  narrow: boolean
  propertiesOpen: boolean
  onProperties?: () => void
  composer: ComposerControls
  bodyRef?: Ref<HTMLDivElement>
  onBodyScroll?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  buttons?: SessionButtons
  schedule?: ScheduleActions | undefined
  /** The "More actions" menu is open. */
  moreOpen?: boolean
}

/** The sheet under its head, as drawn for one state. */
export function SheetView(props: SheetViewProps) {
  const { open, item, detail, form, narrow, propertiesOpen, onProperties, composer, buttons, schedule } = props
  const t = useT()
  const { data, connected, canMutate, canEdit } = useBoardContext()
  const onBoard = (key: string | null) => !!key && !!data?.items.some(i => i.key === key)
  // The rules go by the open session (none once closed); what is shown goes by the one shown.
  const missing = sessionMissing(open, onBoard(open), detail.status)
  const shownMissing = sessionMissing(detail.key, onBoard(detail.key), detail.status)
  const openItem = open ? data?.items.find(i => i.key === open) : undefined
  const availability = sheetAvailability({ canMutate, canEdit, missing, turn: !!openItem && inTurn(openItem) }, t)
  const notice = detailNotice(
    detail,
    { missing: shownMissing, onBoard: onBoard(detail.key), outdated: !connected || !!data?.stale, canEdit },
    t,
  )
  const hasForm = form !== null && form !== undefined && form !== false
  const asking = !hasForm && item?.column === 'me'
  return (
    <>
      <button
        type="button"
        className="sheet-properties-toggle"
        id="sheet-properties-toggle"
        aria-expanded={propertiesOpen}
        aria-controls="sheet-card"
        onClick={() => onProperties?.()}
      >
        {t('sheet.properties')}
      </button>
      <div className="sheet-card" id="sheet-card" hidden={narrow && !propertiesOpen}>
        {/* Each session's card fields start afresh: nothing typed for one shows in another's. */}
        {item && <SheetCard key={item.key} item={item} disabled={availability.edit} schedule={schedule} />}
      </div>
      <div className="sheet-question" id="sheet-question" hidden={!hasForm && !asking}>
        {hasForm
          ? form
          : asking && item && <Asked item={item} disabled={availability.dismiss} onDismiss={props.onDismiss} />}
      </div>
      <div
        className={classNames('sheet-body', !!notice.text && 'has-detail-state')}
        id="sheet-body"
        ref={props.bodyRef}
        onScroll={props.onBodyScroll}
      >
        {item && (
          <>
            <div className="detail-status" id="sheet-detail-state" role="status" hidden={!notice.text}>
              <span>
                {notice.text}
                {notice.stamp && <small>{notice.stamp}</small>}
              </span>
              <button
                type="button"
                className="button"
                data-detail-retry=""
                disabled={notice.retryDisabled}
                onClick={() => props.onRetry?.()}
              >
                {t('detail.retry')}
              </button>
            </div>
            <Screen screen={detail.data?.screen ?? ''} form={hasForm} asking={asking} />
            <div className="section-title">{t('thread.title')}</div>
            <div className="thread">
              <Conversation detail={detail} item={item} />
            </div>
          </>
        )}
      </div>
      <Composer
        composer={composer}
        availability={availability}
        buttons={item ? headButtons(item, t) : NO_HEAD_BUTTONS}
        term={item ? termButton(item, data, t) : undefined}
        changesHidden={!detail.data?.checkout}
        present={!!openItem && detail.status !== 'missing'}
        canMutate={canMutate}
        on={buttons}
        moreOpen={props.moreOpen ?? false}
      />
    </>
  )
}

/** The terminal's screen: folded away under a form that answers it here, else as it is under "Needs me". */
function Screen({ screen, form, asking }: { screen: string; form: boolean; asking: boolean }) {
  const t = useT()
  if (!screen) return null
  if (form)
    return (
      <details className="qa-screen">
        <summary>{t('qa.screen')}</summary>
        <pre className="screen">{screen}</pre>
      </details>
    )
  return asking ? <pre className="screen">{screen}</pre> : null
}

function Conversation({ detail, item }: { detail: DetailSnapshot; item: Item }) {
  const t = useT()
  const conversation = detail.data?.conversation
  const placeholder = threadPlaceholder(conversation, detail.status, t)
  if (placeholder !== null || !conversation) return <p className="row-value muted">{placeholder}</p>
  return <Thread conversation={conversation} item={item} />
}

/** Under "Needs me" with no form to answer: why it stopped, what it asks, and the button that waves it off. */
function Asked({ item, disabled, onDismiss }: { item: Item; disabled: boolean; onDismiss?: (() => void) | undefined }) {
  const t = useT()
  const asked = askedView(item, t)
  return (
    <div className="asked">
      <b>{asked.why}</b>
      {asked.text}
      {asked.dismiss && (
        <button
          type="button"
          className="button asked-dismiss"
          data-act="dismiss"
          disabled={disabled}
          onClick={() => onDismiss?.()}
        >
          <CheckGlyph />
          <span>{asked.dismiss}</span>
        </button>
      )}
    </div>
  )
}
