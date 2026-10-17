// The sheet's foot: why the session's actions wait (no fresh data), the session's buttons — go to
// it in herdr, wake it, put it to sleep, its changes and history, a new session here — the files
// that go with the next message, and the message box: Enter sends, Shift+Enter breaks the line,
// the box grows with the text; files come in through the clip or Ctrl+V (a screenshot).
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react'
import type { ComposerControls } from '../../hooks/useComposer.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { composerView, sendsOnKey } from '../../models/composer.ts'
import type { HeadButtons, SheetAvailability } from '../../models/sheet.ts'
import type { termButton } from '../../models/terminal.ts'
import { classNames } from '../class-names.ts'
import {
  BranchIcon,
  ClipIcon,
  CrossIcon,
  FocusIcon,
  HistoryIcon,
  MoonIcon,
  PlusIcon,
  SendIcon,
  SunIcon,
} from '../icons.tsx'
import { TermIcon } from '../terminal/Terminal.tsx'
import { Attachments } from './Attachments.tsx'

/** What the session's buttons do; each gets the button it was pressed on, for what opens from it. */
export interface SessionButtons {
  focus?: () => void
  /** The terminal window: a shell in the session's folder, or its own terminal (hooks/useTerminal.ts). */
  terminal?: (button: HTMLElement) => void
  wake?: () => void
  sleep?: () => void
  /** The quick look of the checkout's changes (25c). */
  changes?: (button: HTMLElement) => void
  /** The quick look of the project's past sessions (25c). */
  history?: (button: HTMLElement) => void
  /** A new session in this one's lane and folder (the launch window). */
  newHere?: (button: HTMLElement) => void
  /** The menu of these buttons on a phone (`keyboard`: pressed by keys, it lights its first item). */
  more?: (button: HTMLElement, keyboard: boolean) => void
}

export interface ComposerProps {
  composer: ComposerControls
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
  const { text, attachments, sending, messageRef } = composer
  const view = composerView({ present, sending, canMutate, text, attachments }, t)

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
      <div className="composer-actions">
        <button
          type="button"
          className="button sheet-more"
          id="sheet-more"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={e => on.more?.(e.currentTarget, e.detail === 0)}
        >
          {t('sheet.more')}
        </button>
        <button type="button" className="button" id="sheet-focus" disabled={av.focus} onClick={() => on.focus?.()}>
          <FocusIcon />
          <span>{t('sheet.focus')}</span>
        </button>
        <button
          type="button"
          className={classNames('button', term.hasShell && 'has-shell')}
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
          className="button"
          id="sheet-wake"
          hidden={buttons.wakeHidden}
          disabled={av.wake}
          onClick={() => on.wake?.()}
        >
          <SunIcon />
          <span>{t('sheet.wake')}</span>
        </button>
        <button
          type="button"
          className="button"
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
          className="button"
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
          className="button"
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
          className="button"
          id="sheet-new"
          disabled={av.newHere}
          title={av.newHereTitle}
          onClick={e => on.newHere?.(e.currentTarget)}
        >
          <PlusIcon />
          <span>{t('launch.here')}</span>
        </button>
      </div>
      <Attachments list={attachments} onRemove={composer.removeFile} />
      <form
        className="composer-box"
        id="composer"
        onSubmit={e => {
          e.preventDefault()
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
        <textarea
          id="message"
          rows={1}
          placeholder={t('compose.placeholder')}
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
          title={view.sendTitle}
          aria-label={t('compose.sendLabel')}
          disabled={view.sendDisabled}
        >
          <SendIcon />
        </button>
      </form>
    </footer>
  )
}
