// The Team panel's message box (#370). It grows with its text up to a few lines; Enter sends,
// Shift+Enter breaks a line, nothing goes while an IME composes, and Esc lets go of a reply. Over
// the box: a new topic's fields (`header`), the message it answers, and `attachments` (#371: the
// files that go with it); beside Send: `actions` (#371's attach button, New topic). Whether Send
// is on is the parent's word (`canSend`), so a message of files alone can turn it on.
import { type ReactNode, type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { sendsOnKey } from '../../models/composer.ts'
import type { Quote } from '../../models/team-chat.ts'

/** The box grows up to this height (px), then scrolls. */
const MAX_HEIGHT = 168

export interface TeamComposerProps {
  value: string
  placeholder: string
  disabled: boolean
  /** Send is on: there is something to send and nothing in the way. */
  canSend: boolean
  onChange(text: string): void
  onSend(): void
  /** A word for Send other than the arrow (Start the topic): drawn as a button with that text. */
  sendLabel?: string
  sendTitle?: string
  /** The message this one answers, as its quote shows it; null: none. */
  reply?: Quote | null
  onCancelReply?(): void
  /** Over everything: a new topic's or channel's fields. */
  header?: ReactNode
  /** Over the box, under the reply: what goes with the message (#371's files). */
  attachments?: ReactNode
  /** Beside Send, before it: more buttons. */
  actions?: ReactNode
  /** The box itself, for focus (a reply picked). */
  inputRef?: Ref<HTMLTextAreaElement>
}

export function TeamComposer({
  value,
  placeholder,
  disabled,
  canSend,
  onChange,
  onSend,
  sendLabel,
  sendTitle,
  reply,
  onCancelReply,
  header,
  attachments,
  actions,
  inputRef,
}: TeamComposerProps) {
  const t = useT()
  const box = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(inputRef, () => box.current as HTMLTextAreaElement, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is when to measure
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])
  const ready = canSend && !disabled
  return (
    <div className="team-compose" data-composer>
      {header}
      {reply && (
        <div className="team-compose-reply" data-reply={reply.id}>
          <div className="team-quote static">
            <b>{t('team.replyTo', { name: reply.who || t('team.formerOne') })}</b>
            <span>{reply.text ?? t('team.heldText')}</span>
          </div>
          <button
            type="button"
            className="team-icon-button"
            aria-label={t('team.replyCancel')}
            title={t('team.replyCancel')}
            onClick={() => onCancelReply?.()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      )}
      {attachments && <div className="team-compose-attachments">{attachments}</div>}
      <div className="team-compose-row">
        {actions && <div className="team-compose-actions">{actions}</div>}
        <textarea
          ref={box}
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && reply) {
              e.preventDefault()
              onCancelReply?.()
              return
            }
            if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) return
            e.preventDefault()
            if (ready) onSend()
          }}
        />
        {sendLabel ? (
          <button
            type="button"
            className="mini team-send-text"
            data-send
            disabled={!ready}
            title={sendTitle}
            onClick={onSend}
          >
            {sendLabel}
          </button>
        ) : (
          <button
            type="button"
            className="team-send"
            data-send
            disabled={!ready}
            aria-label={t('team.send')}
            title={sendTitle ?? t('team.send')}
            onClick={onSend}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
