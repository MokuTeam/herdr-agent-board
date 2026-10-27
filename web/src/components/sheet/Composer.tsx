// The sheet's foot: why the session's actions wait (no fresh data), the session's buttons — go to
// it in herdr, a MokuPilot call with a fork of it, a fork of it in a new tab, its terminal, its changes, its history, wake it,
// put it to sleep, restart it, take it off the board to the archive, a new session here, as many
// as the row's width holds (hooks/useActionRow.ts), and More at the row's end with the rest — the
// files that go with the next message, and the message box: Enter sends, Shift+Enter breaks the
// line, the box grows with the text; files come in through the clip or Ctrl+V (a screenshot).
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { changesMeter } from '../../../../src/core/effort.ts'
import type { Item } from '../../../../src/core/types.ts'
import { pageLog } from '../../api/client.ts'
import { useActionRow } from '../../hooks/useActionRow.ts'
import type { ComposerControls } from '../../hooks/useComposer.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  canReadClipboard,
  keepPasteHintSeen,
  pasteHintSeen,
  pickInstead,
  readClipboardImages,
} from '../../models/clipboard-image.ts'
import { composerView, sendsOnKey } from '../../models/composer.ts'
import { remotePage } from '../../models/remote-page.ts'
import type { HeadButtons, SheetAvailability } from '../../models/sheet.ts'
import type { termButton } from '../../models/terminal.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import {
  ArchiveIcon,
  BranchIcon,
  ClipIcon,
  CrossIcon,
  FocusIcon,
  ForkIcon,
  HistoryIcon,
  MoonIcon,
  MoreIcon,
  PastePictureIcon,
  PhoneIcon,
  PhotoIcon,
  PlusIcon,
  RestartIcon,
  SendIcon,
  SunIcon,
} from '../icons.tsx'
import { TermIcon } from '../terminal/Terminal.tsx'
import { AsideToggle, useAsideBox } from './Aside.tsx'
import { Attachments } from './Attachments.tsx'
import { SessionMeter } from './SessionMeter.tsx'

/** What the session's buttons do; each gets the button it was pressed on, for what opens from it. */
export interface SessionButtons {
  focus?: () => void
  /** The terminal window: a shell in the session's folder, or its own terminal (hooks/useTerminal.ts). */
  terminal?: (button: HTMLElement) => void
  /** A MokuPilot call whose agent is a fork of the session. */
  mokupilot?: () => void
  /** A fork of the session in a new tab (its window grows out of the button). */
  fork?: (button: HTMLElement) => void
  wake?: () => void
  sleep?: () => void
  /** Claude exits and resumes in its pane once the session is free. */
  restart?: () => void
  /** The quick look of the checkout's changes (25c). */
  changes?: (button: HTMLElement) => void
  /** Off the board until Return: its tab closes, Claude keeps the conversation. */
  archive?: () => void
  /** The quick look of the project's past sessions (25c). */
  history?: (button: HTMLElement) => void
  /** A new session in this one's lane and folder (the launch window). */
  newHere?: (button: HTMLElement) => void
  /** The menu of the buttons the row leaves over (`keyboard`: pressed by keys, it lights its first item). */
  more?: (button: HTMLElement, keyboard: boolean) => void
}

export interface ComposerProps {
  composer: ComposerControls
  /** The open session: its context, model and effort show beside the message box. */
  item?: Item | null
  availability: SheetAvailability
  buttons: HeadButtons
  /** The Terminal button: where the board offers one, with a dot while a shell is open. */
  term?: ReturnType<typeof termButton> | undefined
  /** Until the detail says the folder is in git. */
  changesHidden: boolean
  /** The open session is on the board and its detail does not say it is gone. */
  present: boolean
  canMutate: boolean
  on?: SessionButtons | undefined
  /** The menu of the buttons is open. */
  moreOpen?: boolean
}

/** The box grows with the text, up to 180 px. */
const MAX_HEIGHT = 180

export function Composer({
  composer,
  item = null,
  availability: av,
  buttons,
  term = { hidden: false, hasShell: false, title: '' },
  changesHidden,
  present,
  canMutate,
  on = {},
  moreOpen = false,
}: ComposerProps) {
  const t = useT()
  const fileInput = useRef<HTMLInputElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const row = useActionRow(actions)
  /** `.over`: the row leaves it to More (More itself: nothing is left over). */
  const over = (id: string) => row.over.has(id) && 'over'
  const { text, attachments, sending, messageRef } = composer
  const view = composerView({ present, sending, canMutate, text, attachments }, t)
  // A side question (/btw) instead of a message, where the board can ask one: the box's switch, or "/btw …".
  const aside = useAsideBox(text, composer.input)
  // The /model and /effort messages sent from here: the meter reads the screen after each.
  const [asked, setAsked] = useState(0)

  // On every draw, as syncComposer ran on every one: the text, the language or the panel's width may have moved.
  useLayoutEffect(() => {
    const box = messageRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(MAX_HEIGHT, box.scrollHeight)}px`
  })

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) return
    e.preventDefault()
    e.currentTarget.form?.requestSubmit()
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    composer.addFiles(files)
  }

  return (
    <footer className="composer">
      <p id="sheet-connection-state" role="status" hidden={!av.blocked}>
        {av.banner}
      </p>
      <div className={classNames('composer-actions', row.icons && 'icons')} ref={actions}>
        {/* Not in a phone's browser: herdr's window is on the computer (the row then fits without it). */}
        {!remotePage() && (
          <button
            type="button"
            className={classNames('button', over('sheet-focus'))}
            id="sheet-focus"
            disabled={av.focus}
            onClick={() => on.focus?.()}
          >
            <FocusIcon />
            <span>{t('sheet.focus')}</span>
          </button>
        )}
        <button
          type="button"
          className={classNames('button', over('sheet-mokupilot'))}
          id="sheet-mokupilot"
          hidden={buttons.mokupilotHidden}
          title={t('mokupilot.hint')}
          disabled={av.edit}
          onClick={() => on.mokupilot?.()}
        >
          <PhoneIcon />
          <span>{t('mokupilot.call')}</span>
        </button>
        {/* Only where the board can fork this session: the row is the old page's without it. */}
        {!buttons.forkHidden && (
          <button
            type="button"
            className={classNames('button', over('sheet-fork'))}
            id="sheet-fork"
            title={t('fork.hint')}
            disabled={av.newHere}
            onClick={e => on.fork?.(e.currentTarget)}
          >
            <ForkIcon />
            <span>{t('fork.action')}</span>
          </button>
        )}
        <button
          type="button"
          className={classNames('button', term.hasShell && 'has-shell', over('sheet-term'))}
          id="sheet-term"
          hidden={term.hidden}
          title={term.title || t('term.hint')}
          onClick={e => on.terminal?.(e.currentTarget)}
        >
          <TermIcon />
          <span>{t('term.open')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-changes'))}
          id="sheet-changes"
          hidden={changesHidden}
          disabled={av.files}
          title={t('changes.hint')}
          onClick={e => on.changes?.(e.currentTarget)}
        >
          <BranchIcon />
          <span>{t('changes.open')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-history'))}
          id="sheet-history"
          hidden={buttons.historyHidden}
          disabled={av.files}
          title={t('history.hint')}
          onClick={e => on.history?.(e.currentTarget)}
        >
          <HistoryIcon />
          <span>{t('history.open')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-wake'))}
          id="sheet-wake"
          title={t('sheet.wake')}
          hidden={buttons.wakeHidden}
          disabled={av.wake}
          onClick={() => on.wake?.()}
        >
          <SunIcon />
          <span>{t('sheet.wake')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-sleep'))}
          id="sheet-sleep"
          hidden={buttons.sleepHidden}
          disabled={av.sleep}
          title={buttons.sleepTitle}
          onClick={() => on.sleep?.()}
        >
          <MoonIcon />
          <span>{t('sheet.sleep')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-restart'))}
          id="sheet-restart"
          hidden={buttons.restartHidden}
          disabled={av.restart}
          title={buttons.restartTitle}
          onClick={() => on.restart?.()}
        >
          <RestartIcon />
          <span>{t('sheet.restart')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-archive'))}
          id="sheet-archive"
          hidden={buttons.archiveHidden}
          disabled={av.archive}
          title={buttons.archiveTitle}
          onClick={() => on.archive?.()}
        >
          <ArchiveIcon />
          <span>{t('archive.menu')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-new'))}
          id="sheet-new"
          disabled={av.newHere}
          title={av.newHereTitle}
          onClick={e => on.newHere?.(e.currentTarget)}
        >
          <PlusIcon />
          <span>{t('launch.here')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', over('sheet-more'))}
          id="sheet-more"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title={t('sheet.more')}
          aria-label={t('sheet.more')}
          onClick={e => on.more?.(e.currentTarget, e.detail === 0)}
        >
          <MoreIcon />
        </button>
      </div>
      {aside.deck}
      <Attachments list={attachments} onRemove={composer.removeFile} />
      <form
        className={classNames('composer-box', aside.on && 'aside')}
        id="composer"
        onSubmit={e => {
          e.preventDefault()
          if (aside.submit()) return
          if (changesMeter(text)) setAsked(n => n + 1)
          composer.send()
        }}
      >
        <button
          type="button"
          className="attach"
          id="attach"
          title={t('compose.attach')}
          aria-label={t('compose.attachLabel')}
          disabled={av.edit}
          onClick={() => fileInput.current?.click()}
        >
          <ClipIcon />
        </button>
        {remotePage() && (pickInstead(navigator.userAgent) || canReadClipboard(navigator.clipboard)) && (
          <PastePicture
            disabled={av.edit}
            onFiles={files => {
              if (!files.length) return
              composer.addFiles(files)
              messageRef.current?.focus()
            }}
          />
        )}
        <input
          type="file"
          id="file-input"
          multiple
          hidden
          ref={fileInput}
          onChange={e => {
            composer.addFiles([...(e.currentTarget.files ?? [])])
            e.currentTarget.value = ''
            messageRef.current?.focus()
          }}
        />
        {aside.can && (
          <AsideToggle
            on={aside.on}
            onToggle={() => {
              aside.toggle()
              messageRef.current?.focus()
            }}
          />
        )}
        <textarea
          id="message"
          rows={1}
          placeholder={t(
            aside.on ? 'aside.placeholder' : remotePage() ? 'compose.placeholderPhone' : 'compose.placeholder',
          )}
          aria-label={t('compose.label')}
          ref={messageRef}
          value={text}
          onChange={e => composer.input(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="button"
          className="draft-clear"
          id="draft-cancel"
          hidden={view.discardHidden}
          disabled={view.discardDisabled}
          title={t('draft.cancel')}
          aria-label={t('draft.cancel')}
          onClick={composer.discard}
        >
          <CrossIcon />
        </button>
        <button
          className="send"
          type="submit"
          title={aside.question === null ? view.sendTitle : t('aside.toggle')}
          aria-label={t(aside.question === null ? 'compose.sendLabel' : 'aside.toggle')}
          disabled={aside.question === null ? view.sendDisabled : !aside.question}
        >
          <SendIcon />
        </button>
      </form>
      {item && <SessionMeter key={item.key} item={item} asked={asked} />}
    </footer>
  )
}

/**
 * In a phone's browser only (models/clipboard-image.ts): the picture on the clipboard into the
 * message, as Ctrl+V does on the computer. What went wrong says so, with the paperclip as the way round.
 * A phone's keyboard cannot paste a picture here, so the button says what it is for once, in a small
 * bubble, until it is used or the bubble is tapped away. On Android Chrome hands a page no copied
 * screenshot (#105): there the button opens the picture picker instead, whose newest come first.
 */
function PastePicture({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const t = useT()
  const { toast } = useBoardContext()
  const [pick] = useState(() => pickInstead(navigator.userAgent))
  const kind = pick ? 'pick' : 'paste'
  const [hint, setHint] = useState(() => !pasteHintSeen(kind))
  const picker = useRef<HTMLInputElement>(null)
  const seen = () => {
    setHint(false)
    keepPasteHintSeen(kind)
  }
  const label = t(pick ? 'compose.pickPicture' : 'compose.pastePicture')
  async function paste() {
    if (!canReadClipboard(navigator.clipboard)) return
    const got = await readClipboardImages(navigator.clipboard).catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err)
      return { error: 'failed', why, seen: why } as const
    })
    if ('files' in got) return onFiles(got.files)
    // What the clipboard held, for the board's log: a phone's Chrome may hand over no picture though
    // one was copied (#102), and only the page can see it.
    pageLog(`paste: ${got.error}; the clipboard held ${got.seen}`)
    if (got.error === 'empty') return toast(t('compose.pasteNone', { seen: got.seen }), true)
    toast(got.error === 'denied' ? t('compose.pasteDenied') : t('compose.pasteFailed', { why: got.why ?? '' }), true)
  }
  return (
    <span className="paste-picture">
      <button
        type="button"
        className="attach"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          seen()
          if (pick) picker.current?.click()
          else void paste()
        }}
      >
        {pick ? <PhotoIcon /> : <PastePictureIcon />}
      </button>
      {pick && (
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          ref={picker}
          onChange={e => {
            onFiles([...(e.currentTarget.files ?? [])])
            e.currentTarget.value = ''
          }}
        />
      )}
      {hint && !disabled && (
        <button type="button" className="paste-hint" onClick={seen}>
          {t(pick ? 'compose.pickHint' : 'compose.pasteHint')}
        </button>
      )}
    </span>
  )
}
