// What the session sheet shows around the conversation: its head (status, name, the line under
// it, which buttons show), which of its controls work now, the note over the conversation while
// the detail loads, fails or is out of date, and what the session asks under "Needs me".
import type { Item, Translator } from '../../../src/core/types.ts'
import { ago, dismissable, inTurn } from './card.ts'
import type { DetailStatus, DetailValue } from './detail-resource.ts'

/** The time of a turn, or of the last read: hours and minutes in the board's language. */
export const clockText = (ms: number | null | undefined, t: Translator): string =>
  ms ? new Date(ms).toLocaleTimeString(t.lang, { hour: '2-digit', minute: '2-digit' }) : ''

/** The session is gone: off the board, or its detail says so. Only while one is open. */
export const sessionMissing = (open: string | null, onBoard: boolean, status: DetailStatus | undefined): boolean =>
  !!open && (!onBoard || status === 'missing')

/**
 * A draft goes by the Claude session, else by the card (a session without a Claude id), so it
 * stays with the session through a close, a switch to another one or a reload.
 */
export const draftKey = (it: Pick<Item, 'session' | 'key'> | null | undefined): string | null =>
  it?.session || it?.key || null

/**
 * What the card says that warrants reading its detail again (web/app.js onData). A helper at work
 * changes the sheet too, while the session itself may wait for it.
 */
export const detailStamp = (it: Item): string =>
  `${it.activity}|${it.status}|${it.column}|${it.wait}|${it.doing}|${it.category}|${it.helpers?.at ?? ''}|${it.helpers?.running ?? ''}`

export interface BoardTurn {
  /** The board before this one (none yet: the page starts out of date). */
  before: { stale: boolean } | null
  board: { stale: boolean; items: Item[] }
  /** The open session. */
  key: string
  /** detailStamp() as of the last read ('' right after opening). */
  stamp: string
  status: DetailStatus
}

export type DetailStep = { kind: 'missing' } | { kind: 'load'; stamp: string } | null

/**
 * What a new board means for the open session's detail (web/app.js onData): the session is gone
 * (unless the data is only out of date), or its detail is read again — its card says something
 * new, the data is fresh again, or it is back after it was gone — or nothing.
 */
export function detailOnBoard({ before, board, key, stamp, status }: BoardTurn): DetailStep {
  const it = board.items.find(i => i.key === key)
  if (!it) return board.stale ? null : { kind: 'missing' }
  const now = detailStamp(it)
  const recovered = (before?.stale ?? true) && !board.stale
  return now !== stamp || recovered || status === 'missing' ? { kind: 'load', stamp: now } : null
}

// ---------------------------------------------------------------- the head

export type StatusPill = { kind: 'missing' } | { kind: 'asleep' } | { kind: 'column' }

export interface SheetHeadView {
  pill: StatusPill
  name: string
  /** Its lane, workspace, last activity and context, in one line. */
  /** The facts under the name, each kept whole on its line (the line breaks between them, after a separator). */
  meta: string[]
  /** Says what the context number is, when there is one. */
  metaTitle: string
}

/** The context its last request carried: "context 42% · 85k", or nothing when it is not known. */
export function contextText(it: Pick<Item, 'context' | 'contextPct'>, t: Translator): string {
  const context = it.context
  // String(): an unknown size read "undefined" before too.
  const tokens = String(context != null && context >= 1000 ? `${Math.round(context / 1000)}k` : context)
  if (it.contextPct != null) return t('meta.contextPct', { pct: Math.round(it.contextPct), tokens })
  return context ? t('meta.context', { tokens }) : ''
}

export function sheetHead(
  it: Item,
  { missing, categoryTitle, now, t }: { missing: boolean; categoryTitle: string; now: number; t: Translator },
): SheetHeadView {
  const pill: StatusPill = missing ? { kind: 'missing' } : it.sleeping ? { kind: 'asleep' } : { kind: 'column' }
  const context = contextText(it, t)
  const active = it.activity ? ago(it.activity, now, t) : ''
  const meta = [
    categoryTitle,
    it.workspace && t('meta.workspace', { name: it.workspace }),
    active && (active === t('ago.now') ? t('meta.activeNow') : t('meta.active', { ago: active })),
    context,
  ].filter((s): s is string => !!s)
  return { pill, name: it.name, meta, metaTitle: context ? t('meta.contextHint') : '' }
}

/** Which of the session's buttons show: History needs a Claude project, Wake a sleeping session. */
export interface HeadButtons {
  historyHidden: boolean
  wakeHidden: boolean
  sleepHidden: boolean
  /** Why it cannot sleep now, or what sleeping does; none before a session was ever open. */
  sleepTitle: string | undefined
}

/** Before a session was ever open, the buttons as the page starts. */
export const NO_HEAD_BUTTONS: HeadButtons = {
  historyHidden: false,
  wakeHidden: true,
  sleepHidden: false,
  sleepTitle: undefined,
}

export function headButtons(it: Item, t: Translator): HeadButtons {
  return {
    historyHidden: !it.session,
    wakeHidden: !it.sleeping,
    sleepHidden: !!it.sleeping || !it.session,
    sleepTitle: t(inTurn(it) ? 'sheet.sleepBusy' : 'sheet.sleepHint'),
  }
}

// ---------------------------------------------------------------- the card's own fields

/** A card field being edited: what is typed, in which session, over the card's value when the typing began. */
export type FieldEdit = { text: string; from: string; session: string }

/** The field as the page has it now: whether it has the focus, the card's value, the session it is for. */
export interface FieldScene {
  focused: boolean
  saved: string
  session: string
}

/**
 * The edit still in force, or null once it is over: the typing stays while the field is focused,
 * and after that until the card's own value moves on (a save that went through, another value
 * from the board: the old page drew the field again then). Once over it stays over, and it never
 * goes with the field to another session.
 */
export const liveEdit = (edit: FieldEdit | null, { focused, saved, session }: FieldScene): FieldEdit | null =>
  edit && edit.session === session && (focused || edit.from === saved) ? edit : null

/** The edit after a keystroke. */
export const typing = (edit: FieldEdit | null, scene: FieldScene, text: string): FieldEdit => ({
  text,
  from: liveEdit(edit, scene)?.from ?? scene.saved,
  session: scene.session,
})

// ---------------------------------------------------------------- what works now

export interface SheetAvailability {
  /** No fresh herdr data: the banner says why. */
  blocked: boolean
  banner: string
  /** Disabled, each: */
  focus: boolean
  wake: boolean
  sleep: boolean
  /** The card's chips, fields and schedule buttons, and the clip. */
  edit: boolean
  /** "No reply needed" / "Seen" under the question. */
  dismiss: boolean
  newHere: boolean
  newHereTitle: string
  /** Changes and History. */
  files: boolean
}

export interface AvailabilityScene {
  canMutate: boolean
  canEdit: boolean
  /** sessionMissing() */
  missing: boolean
  /** The open session is in a turn (it cannot sleep now). */
  turn: boolean
}

/**
 * Edits the board keeps itself need only the board; what goes through herdr also needs fresh
 * herdr data. A session that is gone takes every session action with it (web/app.js
 * syncAvailability).
 */
export function sheetAvailability(
  { canMutate, canEdit, missing, turn }: AvailabilityScene,
  t: Translator,
): SheetAvailability {
  const blocked = !canMutate
  const herdr = blocked || missing
  return {
    blocked,
    banner: t(canEdit ? 'mobile.readOnly' : 'live.off'),
    focus: herdr,
    wake: herdr,
    sleep: herdr || turn,
    edit: !canEdit || missing,
    dismiss: !canEdit || missing,
    newHere: herdr,
    newHereTitle: t(blocked ? 'mobile.readOnly' : 'launch.hereHint'),
    files: missing,
  }
}

// ---------------------------------------------------------------- over the conversation

export interface DetailNotice {
  /** Empty: the note is hidden. */
  text: string
  /** "Last read at 12:04", once read. */
  stamp: string
  retryDisabled: boolean
}

export interface NoticeScene {
  /** The session is gone (off the board, or its detail says so). */
  missing: boolean
  onBoard: boolean
  /** No connection, or herdr data out of date. */
  outdated: boolean
  canEdit: boolean
}

/** The note over the conversation (web/app.js renderDetailState). */
export function detailNotice<T>(value: DetailValue<T>, scene: NoticeScene, t: Translator): DetailNotice {
  const { status, data, error } = value
  const text = scene.missing
    ? t('detail.missing')
    : status === 'error'
      ? t('detail.error', { error })
      : scene.outdated && data
        ? t('detail.stale')
        : status === 'loading' && data
          ? t('detail.refreshing')
          : ''
  const stamp = value.at ? t('detail.readAt', { time: clockText(value.at, t) }) : ''
  return { text, stamp, retryDisabled: !scene.canEdit || !scene.onBoard || status === 'loading' }
}

/** What the conversation says while there is none to show: why, or that it is empty. Null: there is one. */
export function threadPlaceholder(
  conversation: readonly unknown[] | null | undefined,
  status: DetailStatus | undefined,
  t: Translator,
): string | null {
  if (!conversation) return t(status === 'error' || status === 'missing' ? 'detail.noTranscript' : 'loading')
  return conversation.length ? null : t('thread.empty')
}

/** Under "Needs me" with no form to answer: why it stopped, what it asks, and the button that takes it off the column. */
export interface AskedView {
  why: string
  text: string
  /** The dismiss button's label, when the question does not need an answer. */
  dismiss: string | null
}

export function askedView(it: Item, t: Translator): AskedView {
  const later = it.attention === 'later'
  return {
    why: t(it.attention ? `why.${it.attention}` : 'why.default'),
    text: later ? t('asked.later') : it.question || t('asked.terminal'),
    dismiss: dismissable(it) ? t(later ? 'asked.seen' : 'asked.noReply') : null,
  }
}
