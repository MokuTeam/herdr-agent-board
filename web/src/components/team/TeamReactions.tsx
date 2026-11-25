// Reactions on Team messages (#687): chips under a message, quick emoji row, and searchable picker.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { QUICK_REACTIONS, searchEmoji } from '../../../../src/core/team-reactions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { LineReaction } from '../../models/team.ts'
import { classNames } from '../class-names.ts'

export function ReactionChips({
  reactions,
  disabled,
  onToggle,
  onAdd,
  addRef,
  addOpen,
}: {
  reactions: readonly LineReaction[]
  disabled?: boolean
  onToggle(emoji: string, remove: boolean): void
  onAdd?: () => void
  addRef?: RefObject<HTMLButtonElement | null>
  addOpen?: boolean
}) {
  const t = useT()
  return (
    <div className="team-reactions">
      {reactions.map(r => {
        const names = [...(r.me ? [t('team.you')] : []), ...r.peers].join(', ')
        const label = t('team.reactToggle', { emoji: r.emoji, count: r.count, who: names })
        return (
          <button
            key={r.emoji}
            type="button"
            className={classNames('team-react-chip', r.me && 'me')}
            aria-pressed={r.me}
            aria-label={label}
            title={names || label}
            disabled={disabled}
            onClick={() => onToggle(r.emoji, r.me)}
          >
            <span className="team-react-emoji">{r.emoji}</span>
            <span className="team-react-count">{r.count}</span>
          </button>
        )
      })}
      {onAdd && !disabled && (
        <button
          ref={addRef}
          type="button"
          className="team-react-chip team-react-add"
          aria-label={t('team.react')}
          title={t('team.react')}
          aria-expanded={addOpen}
          onClick={onAdd}
        >
          +
        </button>
      )}
    </div>
  )
}

export function QuickReactions({
  active,
  onPick,
  onMore,
  moreRef,
  moreOpen,
}: {
  active?: ReadonlySet<string>
  onPick(emoji: string): void
  onMore?: () => void
  moreRef?: RefObject<HTMLButtonElement | null>
  moreOpen?: boolean
}) {
  const t = useT()
  return (
    <div className="team-react-quick">
      {QUICK_REACTIONS.map(emoji => (
        <button
          key={emoji}
          type="button"
          className={classNames('team-react-pick', active?.has(emoji) && 'me')}
          aria-pressed={active?.has(emoji) ?? false}
          aria-label={emoji}
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
      {onMore && (
        <button
          ref={moreRef}
          type="button"
          className="team-react-pick team-react-more"
          aria-label={t('team.reactMore')}
          title={t('team.reactMore')}
          aria-expanded={moreOpen}
          onClick={onMore}
        >
          +
        </button>
      )}
    </div>
  )
}

export function EmojiPicker({
  active,
  anchorRef,
  ignore,
  onPick,
  onClose,
}: {
  active?: ReadonlySet<string>
  anchorRef?: RefObject<HTMLElement | null>
  ignore?: (target: Node) => boolean
  onPick(emoji: string): void
  onClose(): void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<'down' | 'up'>('down')
  const root = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const ignoreRef = useRef(ignore)
  ignoreRef.current = ignore
  const matches = searchEmoji(query)

  useEffect(() => {
    searchRef.current?.focus()
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const onDown = (e: Event) => {
      const target = e.target as Node | null
      if (root.current && target && !root.current.contains(target) && !ignoreRef.current?.(target)) {
        onCloseRef.current()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const anchor = anchorRef?.current ?? root.current?.parentElement
    const scroller = root.current?.closest('.team-scroll')
    const bounds =
      scroller?.getBoundingClientRect() ??
      (typeof window !== 'undefined' && window.innerHeight > 0
        ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
        : null)
    if (anchor && bounds && bounds.height > 0) {
      const ar = anchor.getBoundingClientRect()
      if (bounds.bottom - ar.bottom < 270 && ar.top - bounds.top > bounds.bottom - ar.bottom) {
        setPlace('up')
      }
    }
  }, [anchorRef])

  return (
    <div
      ref={root}
      className="team-emoji-picker"
      data-place={place}
      role="dialog"
      aria-label={t('team.react')}
      onKeyDown={e => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <QuickReactions {...(active && { active })} onPick={onPick} />
      <input
        ref={searchRef}
        type="search"
        className="team-emoji-search"
        value={query}
        placeholder={t('team.reactSearch')}
        aria-label={t('team.reactSearch')}
        onChange={e => setQuery(e.target.value)}
      />
      {matches.length ? (
        <div className="team-emoji-grid">
          {matches.map(e => (
            <button
              key={e.emoji}
              type="button"
              className={classNames('team-emoji-btn', active?.has(e.emoji) && 'me')}
              aria-label={e.short}
              aria-pressed={active?.has(e.emoji) ?? false}
              title={`:${e.short}:`}
              onClick={() => onPick(e.emoji)}
            >
              {e.emoji}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint team-emoji-empty">{t('team.reactNoMatch')}</p>
      )}
    </div>
  )
}
