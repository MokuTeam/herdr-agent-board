// The Team panel's message box (#370). It grows with its text up to a few lines; Enter sends,
// Shift+Enter breaks a line, nothing goes while an IME composes, and Esc lets go of a reply. Over
// the box: a new topic's fields (`header`), the message it answers, and `attachments` (#371: the
// files that go with it); beside Send: `actions` (#371's attach button, New topic). Whether Send
// is on is the parent's word (`canSend`), so a message of files alone can turn it on.
import { type ReactNode, type Ref, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { mentionAt } from '../../../../src/core/team-directory.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { sendsOnKey } from '../../models/composer.ts'
import { MENTION_NONE_KEY, type MentionPerson, type MentionRow, mentionRows } from '../../models/team.ts'
import type { Quote } from '../../models/team-chat.ts'

/** The composer's list after `@` shows this many lines at most (#832). */
const MAX_CHOICES = 8

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
  /**
   * The teammates and their agents (#832, #842): after `@` the box lists the teammates whose name
   * fits, and Enter or Tab puts `@Name.` in, which lists that teammate's agents; picking one puts
   * `@Name.code ` in. A teammate without agents shows one line there that says why, which puts
   * nothing in. None: no list, the box as before.
   */
  mentions?: readonly MentionPerson[]
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
  mentions = [],
}: TeamComposerProps) {
  const t = useT()
  const box = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const caretAfter = useRef<number | null>(null)
  // Where the caret is, the choice under the keys, and the list let go of with Esc until the text moves.
  const [caret, setCaret] = useState(value.length)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState<string | null>(null)
  const at = mentions.length ? mentionAt(value, caret) : null
  const fits = at && closed !== value ? mentionRows(mentions, at.who, at.code).slice(0, MAX_CHOICES) : []
  // The keys go to the list only while it holds something to put in (#842): the line that says why
  // a teammate has no agents is all it holds then, and Enter, Tab and the arrows do as before.
  const pickable = fits.some(c => c.insert)
  const current = pickable ? Math.min(active, fits.length - 1) : -1
  const pick = (c: MentionRow): void => {
    if (!at || !c.insert) return
    const word = c.insert
    const next = value.slice(0, at.start) + word + value.slice(caret)
    const end = at.start + word.length
    onChange(next)
    setCaret(end)
    setActive(0)
    // Put after the new text once it is drawn (the effect on `value` below).
    caretAfter.current = end
  }
  // The caret is followed only while there are teammates to offer: a box without them does as before.
  const follow = (el: HTMLTextAreaElement): void => {
    if (mentions.length) setCaret(el.selectionStart ?? el.value.length)
  }
  useImperativeHandle(inputRef, () => box.current as HTMLTextAreaElement, [])
  // The choice under the keys stays in sight: lines that say why wrap, and the list scrolls.
  useLayoutEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current, listId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is when to measure
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    if (caretAfter.current !== null) {
      el.setSelectionRange(caretAfter.current, caretAfter.current)
      caretAfter.current = null
    }
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
      {fits.length > 0 && (
        <div
          className="team-mentions"
          id={listId}
          role="listbox"
          aria-label={t(at?.code === null ? 'team.mentionPeople' : 'team.mentions')}
          data-mentions={at?.code === null ? 'people' : 'agents'}
        >
          {fits.map((c, i) => (
            <button
              key={c.key}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === current}
              {...(c.none && { 'aria-disabled': true, 'data-none': c.none })}
              className={c.none ? 'team-mention none' : 'team-mention'}
              data-mention={c.word}
              data-kind={c.kind}
              // Picked on the press: the box keeps its focus and its caret.
              onPointerDown={e => {
                e.preventDefault()
                pick(c)
              }}
            >
              <span className="team-mention-word">@{c.word}</span>
              {c.kind === 'person' && (
                <span className="team-mention-more" aria-hidden="true">
                  ›
                </span>
              )}
              {c.none ? (
                <span className="team-mention-about">{t(MENTION_NONE_KEY[c.none])}</span>
              ) : (
                c.about && <span className="team-mention-about">{c.about}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="team-compose-row">
        {actions && <div className="team-compose-actions">{actions}</div>}
        <textarea
          ref={box}
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          {...(mentions.length > 0 && { 'aria-autocomplete': 'list' as const })}
          {...(fits.length > 0 && { 'aria-controls': listId, 'aria-expanded': true })}
          {...(current >= 0 && { 'aria-activedescendant': `${listId}-${current}` })}
          onChange={e => {
            onChange(e.target.value)
            follow(e.target)
            setActive(0)
          }}
          onSelect={e => follow(e.currentTarget)}
          onKeyDown={e => {
            // The list after `@` (#832) takes the arrows, Enter, Tab and Esc while it shows.
            if (fits.length > 0 && !e.nativeEvent.isComposing) {
              const i = current
              if (pickable && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setActive((i + (e.key === 'ArrowDown' ? 1 : fits.length - 1)) % fits.length)
                return
              }
              const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
              if (pickable && ((e.key === 'Enter' && plain) || (e.key === 'Tab' && plain))) {
                e.preventDefault()
                const c = fits[i]
                if (c) pick(c)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setClosed(value)
                return
              }
            }
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
