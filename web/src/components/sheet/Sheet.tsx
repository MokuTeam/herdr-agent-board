// The session sheet: the session panel with the open session's head (its card fields in it), what it
// asks, the conversation and the message box. It opens for a card (the board's `open`, "Write" with the
// message box ready); a click on another card switches it to that session, and while it slides
// out it keeps showing the last one. Files dropped anywhere on the panel go with the message.
//
// Parts the page hands in plug in here: the question form or permission prompt, the file chips and
// quick looks, the reminders' buttons (the page's schedule desk, shared with the schedule panel);
// the phone's "More actions" menu and renaming; "New here" opens the launch window.
import { type ReactNode, type Ref, useLayoutEffect, useRef, useState } from 'react'
import { archiveBlock } from '../../../../src/core/archive.ts'
import type { Item } from '../../../../src/core/types.ts'
import type { SessionDetail } from '../../api/client.ts'
import { type ComposerControls, useComposer } from '../../hooks/useComposer.ts'
import type { SheetPick } from '../../hooks/useContextMenus.ts'
import { useFileDrop } from '../../hooks/useFileDrop.ts'
import { useGoToSession } from '../../hooks/useGoToSession.ts'
import type { HelpersUi } from '../../hooks/useHelpers.ts'
import { useKeepFocus } from '../../hooks/useKeepFocus.ts'
import { type OpenLaunch, useNewSession } from '../../hooks/useNewSession.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { type DetailSnapshot, useSessionDetail } from '../../hooks/useSessionDetail.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { inTurn } from '../../models/card.ts'
import { ConversationScroll } from '../../models/conversation-scroll.ts'
import { restartPending } from '../../models/restart.ts'
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
import { HelpersStrip } from '../helpers/HelpersStrip.tsx'
import { CheckGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { Composer, type SessionButtons } from './Composer.tsx'
import type { ScheduleActions } from './ScheduleRow.tsx'
import { SheetHead } from './SheetHead.tsx'
import { Thread, Waiting } from './Thread.tsx'
import type { ThreadLinks } from './ThreadLinks.tsx'

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
  /** A pill in the head (where the card shows, its lane): its choices as a menu out of it. */
  onPick?: ((kind: SheetPick, button: HTMLElement, keyboard: boolean) => void) | undefined
  /** The pill whose menu is open. */
  pickOpen?: SheetPick | null | undefined
  /** Rename where the name is, in the head (hooks/useRenameInPlace.ts). */
  onRename?: ((key: string, name: HTMLElement) => void) | undefined
  /** Rename the session's herdr workspace where its name is, in the head's line (hooks/useRenameInPlace.ts). */
  onRenameWorkspace?: ((key: string, name: HTMLElement) => void) | undefined
  /** "New here": the launch window, from the button (without fresh data, the toast that says why). */
  onNewSession?: OpenLaunch | undefined
  /** "Terminal": the terminal window of the session, from the button (hooks/useTerminal.ts). */
  onTerminal?: ((key: string, button: HTMLElement) => void) | undefined
  /** The session's helpers in their window (hooks/useHelpers.ts): it reads the sheet's detail. */
  helpers?: HelpersUi | undefined
  /** "Archive": off the board until Return (hooks/useArchive.ts). */
  onArchive?: ((key: string) => void) | undefined
  /** "Fork": a fork of the session in a new tab, its window out of the button (hooks/useFork.ts). */
  onFork?: ((key: string, button: HTMLElement) => void) | undefined
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
  const {
    question,
    upgradeFiles,
    onChanges,
    onHistory,
    onMore,
    onRename,
    onRenameWorkspace,
    onNewSession,
    onTerminal,
    helpers,
    onArchive,
    onFork,
  } = slots
  const t = useT()
  const { data, ui, dispatch, canEdit } = useBoardContext()
  const actions = useSessionActions()
  const fallbackNewSession = useNewSession()
  const newSession = onNewSession ?? fallbackNewSession
  const open = ui.open
  const itemOf = (key: string | null) => (key ? data?.items.find(i => i.key === key) : undefined)
  const shown = useShown(open, itemOf(open))
  const detail = useSessionDetail(shown.key)
  const composer = useComposer(detail.load, detail.value)
  const drop = useFileDrop(composer.addFiles)
  const body = useRef<HTMLDivElement>(null)

  // The card's empty fields show only when asked for; each session opens without them.
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
  const [scroll] = useState(() => new ConversationScroll())
  // biome-ignore lint/correctness/useExhaustiveDependencies: an opening is when to go to the bottom
  useLayoutEffect(() => scroll.opened(), [scroll, open, ui.opened])
  // A message going out: the thread goes to its foot, where its bubble is.
  useLayoutEffect(() => {
    if (composer.outbox.foot) scroll.opened()
  }, [scroll, composer.outbox.foot])
  // The helpers window lists what the open session's detail says.
  const fed = open !== null && detail.value.key === open ? detail.value.data : null
  useLayoutEffect(() => helpers?.engine.feed({ key: open, data: fed }), [helpers, open, fed])
  const goToSession = useGoToSession()
  const links: SheetLinks = {
    onHelper: (id, el) => helpers?.show({ id }, el),
    onList: (run, el) => helpers?.show({ list: true, run }, el),
    onSession: goToSession,
  }
  const cwd = shown.item?.cwd ?? ''
  const drawn = shown.item !== null
  // The conversation drawn anew (a new detail, the session shown, the language): its paths are new.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to look, not what it reads
  useLayoutEffect(() => {
    if (body.current && drawn) upgradeFiles?.(body.current, cwd)
  }, [detail.value.data, drawn, shown.key, cwd, t, upgradeFiles])
  const form = shown.item ? question?.(shown.item, detail.value.data) : null
  const hasForm = form !== null && form !== undefined && form !== false
  // Once its paths are chips: a conversation drawn anew (what upstream's renderSheetBody draws it
  // from) stays at the bottom if it was there; any other render leaves its scroll alone.
  useLayoutEffect(() =>
    scroll.rendered(body.current, [
      detail.value,
      shown.key,
      ui.opened,
      t,
      hasForm,
      shown.item?.column,
      composer.outbox.version,
    ]),
  )

  const at = (act: (key: string) => unknown) => () => void (open && act(open))
  const item = itemOf(open)
  const buttons: SessionButtons = {
    focus: at(actions.focusSession),
    terminal: button => open && onTerminal?.(open, button),
    wake: at(actions.wakeSession),
    sleep: at(actions.sleepSession),
    restart: at(actions.restartSession),
    archive: () => void (open && onArchive?.(open)),
    mokupilot: at(actions.callMokuPilot),
    fork: button => open && onFork?.(open, button),
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
          onRenameWorkspace={onRenameWorkspace && (name => open && onRenameWorkspace(open, name))}
          card={{
            disabled: !canEdit || sessionMissing(open, !!itemOf(open), detail.value.status),
            open: propertiesOpen,
            onToggle: () => setPropertiesOpen(was => !was),
            pickOpen: slots.pickOpen,
            onPick: slots.onPick,
            schedule: slots.schedule,
            onSession: goToSession,
            onFavorite: () => open && void actions.setFavorite(open, !itemOf(open)?.favorite),
          }}
        />
      }
    >
      <SheetView
        open={open}
        item={shown.item}
        detail={detail.value}
        form={form}
        composer={composer}
        bodyRef={body}
        onBodyScroll={() => body.current && scroll.scrolled(body.current)}
        onRetry={() => open && detail.load(open)}
        onDismiss={at(actions.dismissAsk)}
        buttons={buttons}
        moreOpen={slots.moreOpen ?? false}
        links={links}
      />
    </Panel>
  )
}

/** Where the sheet's helpers and links lead: the helpers window, another session. */
export interface SheetLinks {
  onHelper(id: string, el: HTMLElement): void
  /** The list, at a workflow run's agents (`run`) or from the top. */
  onList(run: string | null, el: HTMLElement): void
  onSession(key: string): void
}

export interface SheetViewProps {
  /** The open session; null once the sheet closed (it keeps showing `item`). */
  open: string | null
  item: Item | null
  detail: DetailSnapshot
  /** The form the session waits on, in place of what it asks (SheetSlots.question). */
  form?: ReactNode
  composer: ComposerControls
  bodyRef?: Ref<HTMLDivElement>
  onBodyScroll?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  buttons?: SessionButtons
  /** The "More actions" menu is open. */
  moreOpen?: boolean
  links?: SheetLinks | undefined
}

/** The sheet under its head, as drawn for one state. */
export function SheetView(props: SheetViewProps) {
  const { open, item, detail, form, composer, buttons } = props
  const t = useT()
  const { data, connected, canMutate, canEdit } = useBoardContext()
  // A redraw of the conversation keeps the focus on what opens the same thing (a helper's line).
  const keepFocus = useKeepFocus()
  const onBoard = (key: string | null) => !!key && !!data?.items.some(i => i.key === key)
  // The rules go by the open session (none once closed); what is shown goes by the one shown.
  const missing = sessionMissing(open, onBoard(open), detail.status)
  const shownMissing = sessionMissing(detail.key, onBoard(detail.key), detail.status)
  const openItem = open ? data?.items.find(i => i.key === open) : undefined
  const schedules = data?.schedules ?? []
  const availability = sheetAvailability(
    {
      canMutate,
      canEdit,
      missing,
      turn: !!openItem && inTurn(openItem),
      restarting: !!open && restartPending(schedules, open),
      archiveBlocked: !!archiveBlock(openItem, schedules),
    },
    t,
  )
  const notice = detailNotice(
    detail,
    { missing: shownMissing, onBoard: onBoard(detail.key), outdated: !connected || !!data?.stale, canEdit },
    t,
  )
  const hasForm = form !== null && form !== undefined && form !== false
  const asking = !hasForm && item?.column === 'me'
  return (
    <>
      <div className="sheet-question" id="sheet-question" hidden={!hasForm && !asking}>
        {hasForm
          ? form
          : asking && item && <Asked item={item} disabled={availability.dismiss} onDismiss={props.onDismiss} />}
      </div>
      <HelpersStrip
        helpers={(item && detail.data?.helpers) || []}
        workflows={(item && detail.data?.workflows) || []}
        onHelper={(id, el) => props.links?.onHelper(id, el)}
        onList={(run, el) => props.links?.onList(run, el)}
      />
      <div
        className={classNames('sheet-body', !!notice.text && 'has-detail-state')}
        id="sheet-body"
        ref={props.bodyRef}
        onScroll={props.onBodyScroll}
        {...keepFocus}
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
              <Conversation
                detail={detail}
                item={item}
                links={props.links}
                composer={composer}
                onResize={props.onBodyScroll}
              />
            </div>
          </>
        )}
      </div>
      <Composer
        composer={composer}
        item={item}
        effort={detail.data?.effort ?? ''}
        availability={availability}
        buttons={item ? headButtons(item, t, !!data?.mokupilot, schedules, !!data?.fork) : NO_HEAD_BUTTONS}
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

interface ConversationProps {
  detail: DetailSnapshot
  item: Item
  links?: SheetLinks | undefined
  /** The board's own messages at the thread's foot. */
  composer: ComposerControls
  /** A long message opened or folded again: where the reader is counts again (the body's scroll). */
  onResize?: (() => void) | undefined
}

function Conversation({ detail, item, links, composer, onResize }: ConversationProps) {
  const t = useT()
  const { data } = useBoardContext()
  const conversation = detail.data?.conversation
  // The foot: the session's queue, then the board's own messages on their way or not sent.
  const queued = detail.data?.queued ?? []
  const own = composer.outbox.waiting(item.key)
  const foot = (queued.length > 0 || own.length > 0) && (
    <Waiting queued={queued} own={own} onRetry={composer.outbox.retry} onEdit={composer.outbox.edit} />
  )
  const placeholder = threadPlaceholder(conversation, detail.status, t)
  if (placeholder !== null || !conversation) return foot || <p className="row-value muted">{placeholder}</p>
  // The thread's links: a helper's conversation, a workflow's agents, another session.
  const thread: ThreadLinks = {
    helpers: detail.data?.helpers ?? [],
    workflows: detail.data?.workflows ?? [],
    items: data?.items ?? [],
    onHelper: (id, el) => links?.onHelper(id, el),
    onRun: (id, el) => links?.onList(id, el),
    onSession: key => links?.onSession(key),
    onResize,
  }
  return (
    <>
      <Thread conversation={conversation} item={item} links={thread} />
      {foot}
    </>
  )
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
