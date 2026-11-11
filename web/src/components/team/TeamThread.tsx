// A Team thread on show (#370), laid out as a messenger's conversation:
//
// - The head: back (when the panel shows one thing at a time), the title (the person, the team
//   chat, a topic's or channel's title), under it who it is with or a channel's members and its
//   link, New topic in a general thread, and the mute. A key that changed says so with Trust; a
//   channel this board started can take more members.
// - The messages: a separator for each day, one sender's messages a few minutes apart under one
//   name, the "new messages" line where the unread start. The thread opens at that line, or at the
//   end; it follows new messages while you are at the end, and offers a jump to the latest
//   (with what came in meanwhile) while you are not. A quote scrolls to the message it answers.
// - Under them: an agent's held drafts with Send and Discard, then the box to write in.
import { useLayoutEffect, useRef, useState } from 'react'
import type { NewTopic } from '../../hooks/useTeam.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { reducedMotion } from '../../models/spring.ts'
import {
  type AgentsView,
  draftWhy,
  isChannel,
  keyParts,
  safeLink,
  seenLine,
  type TeamRosterPeer,
  type TeamView,
  type ThreadLine,
  type ThreadView,
} from '../../models/team.ts'
import { chatItems, type Quote, quoteOf } from '../../models/team-chat.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { MessageText } from '../sheet/MessageText.tsx'
import { Switch } from './Switch.tsx'
import { TeamComposer } from './TeamComposer.tsx'
import { QuoteView, TeamMessage } from './TeamMessage.tsx'

/** Closer to the end than this (px), the reader is at the end: new messages scroll into view. */
const AT_END_PX = 48
/** How long a message jumped to from a quote stays lit (ms). */
const FLASH_MS = 1600
/** How far over the "new messages" line the thread opens (px): the day's pill sticks there. */
const UNREAD_ROOM = 44

export interface TeamThreadProps {
  view: TeamView
  selected: string
  thread: ThreadView | null
  lines: ThreadLine[]
  agents: AgentsView | null
  /** The first unread line when the thread opened: where the "new messages" line goes; null: none. */
  unreadFrom: string | null
  draft: string
  topic: NewTopic | null
  /** The line the message being written answers; null: none. */
  replyTo: string | null
  disabled: boolean
  onBack(): void
  onTrust(peer: string): void
  onSendDraft(id: string): void
  onDiscardDraft(id: string): void
  onDraft(text: string): void
  onTopic(topic: NewTopic | null): void
  onSend(): void
  onMute(key: string, muted: boolean): void
  onReply(id: string | null): void
  onAddMembers?(key: string, peers: string[]): void
}

export function TeamThread(props: TeamThreadProps) {
  const { view, selected, thread, lines, unreadFrom, draft, topic, replyTo, disabled } = props
  const t = useT()
  const { now } = useBoardContext()
  const box = useRef<HTMLTextAreaElement>(null)
  const parts = keyParts(selected)
  const scope = parts?.scope ?? ''
  const general = parts?.id === 'general'
  const team = scope === 'team'
  const peer = team ? null : (view.roster.find(p => p.peer === scope) ?? null)
  const changed = peer?.pin === 'changed'
  const channel = isChannel(thread)
  const messages = lines.filter(l => l.dir !== 'draft')
  const drafts = lines.filter(l => l.dir === 'draft')
  const items = chatItems(messages, { t, now, unreadFrom })
  const scroll = useChatScroll(selected, messages)
  const reply = replyTo && !topic ? quoteOf(replyTo, messages, t) : null
  const named = team || channel
  const canWrite = !disabled && !changed
  const sendable =
    draft.trim() !== '' && !changed && !(topic !== null && (!topic.title.trim() || topic.members?.length === 0))
  const name = channel ? (thread?.title ?? '') : team ? t('team.chat') : (peer?.name ?? thread?.peerName ?? '')
  const pickReply = (id: string) => {
    props.onReply(id)
    box.current?.focus()
  }
  return (
    <section className="team-thread" data-thread={selected}>
      <ThreadHead {...props} name={name} peer={peer} channel={channel} general={general} />
      <div className="team-scroll-wrap">
        <div className="team-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
          {!messages.length && !drafts.length && <p className="hint team-empty">{t('team.threadEmpty')}</p>}
          {items.map(item =>
            item.kind === 'day' ? (
              <div key={item.key} className="team-day">
                <span>{item.label}</span>
              </div>
            ) : item.kind === 'unread' ? (
              <div key={item.key} className="team-unread-line" data-unread-line>
                <span>{t('team.newMessages')}</span>
              </div>
            ) : (
              <TeamMessage
                key={item.key}
                line={item.line}
                first={item.first}
                last={item.last}
                named={named}
                quote={item.line.replyTo ? quoteOf(item.line.replyTo, messages, t) : null}
                flash={scroll.flash === item.line.id}
                onReply={canWrite && item.line.text !== null ? pickReply : undefined}
                onQuote={scroll.jumpTo}
              />
            ),
          )}
        </div>
        {!scroll.atEnd && (
          <button
            type="button"
            className="team-jump"
            aria-label={t('team.toLatest')}
            title={t('team.toLatest')}
            onClick={scroll.toEnd}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
            </svg>
            {scroll.fresh > 0 && <span className="team-unread">{scroll.fresh}</span>}
          </button>
        )}
      </div>
      <div className="team-foot">
        {drafts.map(d => (
          <AgentDraft
            key={d.id}
            line={d}
            disabled={disabled}
            changed={changed}
            onSend={props.onSendDraft}
            onDiscard={props.onDiscardDraft}
            quote={d.replyTo ? quoteOf(d.replyTo, messages, t) : null}
            onQuote={scroll.jumpTo}
          />
        ))}
        {changed && <p className="hint">{t('team.sendChanged')}</p>}
        <TeamComposer
          value={draft}
          inputRef={box}
          placeholder={
            channel ? t('team.channelPlaceholder') : team ? t('team.chatPlaceholder') : t('team.placeholder', { name })
          }
          disabled={disabled}
          canSend={sendable}
          onChange={props.onDraft}
          onSend={props.onSend}
          reply={reply}
          onCancelReply={() => props.onReply(null)}
          sendTitle={t('team.sendHint')}
          {...(topic && {
            sendLabel: topic.members ? t('team.startChannel') : t('team.startTopic'),
            header: <TopicFields view={view} topic={topic} onTopic={props.onTopic} />,
          })}
        />
      </div>
    </section>
  )
}

/** The thread's head: back, the title and who it is with, New topic, the mute; Trust and Add a member under it. */
function ThreadHead({
  view,
  selected,
  thread,
  agents,
  topic,
  disabled,
  name,
  peer,
  channel,
  general,
  onBack,
  onTrust,
  onTopic,
  onMute,
  onAddMembers,
}: TeamThreadProps & { name: string; peer: TeamRosterPeer | null; channel: boolean; general: boolean }) {
  const t = useT()
  const { now } = useBoardContext()
  const team = keyParts(selected)?.scope === 'team'
  const changed = peer?.pin === 'changed'
  // A channel's members by this board's names for them, this board left out (#355).
  const memberNames = (thread?.members ?? [])
    .filter(m => m !== view.me.peer)
    .map(m => view.roster.find(p => p.peer === m)?.name ?? t('team.formerOne'))
  const where = channel
    ? t('team.channelOf', { names: memberNames.join(', ') })
    : team
      ? general
        ? null
        : t('team.chat')
      : general && peer
        ? seenLine(peer, now, t)
        : t('team.with', { name })
  const title = channel ? name : general ? name : (thread?.title ?? t('team.general'))
  const link = safeLink(thread?.link)
  // The team chat's mute is its own threads', not a channel's.
  const chatMuted = team && !channel && agents?.peers.team?.muted === true
  // Who may be added: in the roster, not a member yet; only in a channel this board started.
  const addable =
    channel && thread?.by === 'me' && onAddMembers && agents
      ? view.roster.filter(p => !(thread?.members ?? []).includes(p.peer))
      : []
  return (
    <header className="team-thread-head">
      <div className="team-thread-bar">
        <button
          type="button"
          className="team-icon-button team-back"
          aria-label={t('team.back')}
          title={t('team.back')}
          onClick={onBack}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
        <div className="team-thread-id">
          <h3 className="team-thread-title">{title}</h3>
          <p className="sheet-meta">
            {where}
            {link && (
              <>
                {where && ' · '}
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {link}
                </a>
              </>
            )}
            {(thread?.muted || chatMuted) && `${where || link ? ' · ' : ''}${t('team.mutedHint')}`}
          </p>
        </div>
        {general && !topic && (
          <button type="button" className="mini" disabled={disabled} onClick={() => onTopic({ title: '' })}>
            {t('team.newTopic')}
          </button>
        )}
        {thread && (
          <Switch
            name="mute"
            on={!thread.muted}
            label={thread.muted ? t('team.unmute') : t('team.mute')}
            disabled={disabled}
            onFlip={on => onMute(selected, !on)}
          />
        )}
      </div>
      {addable.length > 0 && thread && (
        <AddMember peers={addable} disabled={disabled} onAdd={id => onAddMembers?.(thread.key, [id])} />
      )}
      {changed && peer && (
        <div className="team-changed">
          <p>{t('team.changed', { name: peer.name })}</p>
          {agents ? (
            <button type="button" className="mini" disabled={disabled} onClick={() => onTrust(peer.peer)}>
              {t('team.trust')}
            </button>
          ) : (
            <p className="hint">{t('team.trustOnComputer')}</p>
          )}
        </div>
      )}
    </header>
  )
}

/**
 * An agent's draft the board held (#231, #216): over the box, with why, Send and Discard, and the
 * quote of the message it answers when the agent replied to one (#373).
 */
function AgentDraft({
  line,
  disabled,
  changed,
  onSend,
  onDiscard,
  quote,
  onQuote,
}: {
  line: ThreadLine
  disabled: boolean
  changed: boolean
  onSend(id: string): void
  onDiscard(id: string): void
  quote: Quote | null
  onQuote(id: string): void
}) {
  const t = useT()
  return (
    <div className="team-draft" data-line={line.id}>
      <div className="team-agent-mark">
        <span>{t('team.draftFromAgent')}</span>
        {line.agent && <code>{line.agent}</code>}
        {line.reason && <span>{draftWhy(line.reason, t)}</span>}
      </div>
      {quote && <QuoteView quote={quote} onQuote={onQuote} />}
      <MessageText text={line.text ?? ''} />
      <div className="team-draft-actions">
        <button type="button" className="mini" disabled={disabled} onClick={() => onDiscard(line.id)}>
          {t('team.discard')}
        </button>
        <button
          type="button"
          className="mini primary"
          disabled={disabled || changed}
          title={t('team.draftSendHint')}
          onClick={() => onSend(line.id)}
        >
          {t('team.send')}
        </button>
      </div>
    </div>
  )
}

/** A new topic's or channel's fields over the box: its title, a link, and a channel's members. */
function TopicFields({
  view,
  topic,
  onTopic,
}: {
  view: TeamView
  topic: NewTopic
  onTopic(topic: NewTopic | null): void
}) {
  const t = useT()
  return (
    <div className="team-topic">
      <div className="team-topic-head">
        <b>{topic.members ? t('team.newChannel') : t('team.newTopic')}</b>
        <button type="button" className="mini" onClick={() => onTopic(null)}>
          {t('team.cancel')}
        </button>
      </div>
      <input
        value={topic.title}
        maxLength={80}
        placeholder={topic.members ? t('team.channelTitle') : t('team.topicTitle')}
        aria-label={topic.members ? t('team.channelTitle') : t('team.topicTitle')}
        onChange={e => onTopic({ ...topic, title: e.target.value })}
      />
      <input
        value={topic.link ?? ''}
        type="url"
        placeholder={t('team.topicLink')}
        aria-label={t('team.topicLink')}
        onChange={e => onTopic({ ...topic, link: e.target.value })}
      />
      {topic.members && (
        <div className="team-lanes" data-members>
          <span className="todo-meta">{t('team.channelMembers')}</span>
          {view.roster.map(p => {
            const picked = topic.members?.includes(p.peer) === true
            return (
              <button
                key={p.peer}
                type="button"
                className="mini team-lane"
                aria-pressed={picked}
                onClick={() =>
                  onTopic({
                    ...topic,
                    members: picked
                      ? (topic.members ?? []).filter(m => m !== p.peer)
                      : [...(topic.members ?? []), p.peer],
                  })
                }
              >
                {p.name}
              </button>
            )
          })}
          <span className="hint">{t('team.channelHint')}</span>
        </div>
      )}
    </div>
  )
}

/** Add a member to a channel this board started: one of the roster, not a member yet (#355). */
function AddMember({
  peers,
  disabled,
  onAdd,
}: {
  peers: TeamRosterPeer[]
  disabled: boolean
  onAdd(peer: string): void
}) {
  const t = useT()
  const [pick, setPick] = useState(peers[0]?.peer ?? '')
  // The one on show: after an add the list is shorter, and a pick no longer in it is not posted.
  const value = peers.some(p => p.peer === pick) ? pick : (peers[0]?.peer ?? '')
  return (
    <div className="team-switch-row team-add">
      <select
        value={value}
        aria-label={t('team.addMember')}
        disabled={disabled}
        onChange={e => setPick(e.target.value)}
      >
        {peers.map(p => (
          <option key={p.peer} value={p.peer}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" className="mini" disabled={disabled || !value} onClick={() => onAdd(value)}>
        {t('team.addMember')}
      </button>
    </div>
  )
}

/**
 * The conversation's scrolling: it opens at the "new messages" line (near the top) or at the end;
 * it follows new messages while the reader is at the end and counts the ones that came in while
 * they are not; a quote's jump centres the message answered and lights it once.
 */
function useChatScroll(key: string, messages: readonly ThreadLine[]) {
  const ref = useRef<HTMLDivElement>(null)
  const opened = useRef<string | null>(null)
  const seen = useRef(0)
  const end = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  const [fresh, setFresh] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const behavior = (): ScrollBehavior => (reducedMotion.matches ? 'auto' : 'smooth')
  const count = messages.length
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread or a new message is when to look
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (opened.current !== key) {
      if (!count) return
      opened.current = key
      seen.current = count
      const line = el.querySelectorAll<HTMLElement>('[data-unread-line]')[0]
      // Clear of the day's pill that sticks to the top.
      if (line) el.scrollTop = Math.max(0, line.offsetTop - UNREAD_ROOM)
      else el.scrollTop = el.scrollHeight
      end.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX
      setAtEnd(end.current)
      setFresh(0)
      return
    }
    if (count <= seen.current) {
      seen.current = count
      return
    }
    const added = messages.slice(seen.current).filter(m => m.dir === 'in').length
    const mine = messages.slice(seen.current).some(m => m.dir === 'out')
    seen.current = count
    if (end.current || mine) el.scrollTo({ top: el.scrollHeight, behavior: behavior() })
    else setFresh(n => n + added)
  }, [key, count])
  return {
    ref,
    atEnd,
    fresh,
    flash,
    onScroll() {
      const el = ref.current
      if (!el) return
      const now = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX
      end.current = now
      if (now !== atEnd) setAtEnd(now)
      if (now && fresh) setFresh(0)
    },
    toEnd() {
      const el = ref.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: behavior() })
      setFresh(0)
    },
    jumpTo(id: string) {
      const all = ref.current?.querySelectorAll<HTMLElement>('[data-line]') ?? []
      const target = [...all].find(x => x.getAttribute('data-line') === id)
      if (!target) return
      target.scrollIntoView?.({ block: 'center', behavior: behavior() })
      if (flashTimer.current) clearTimeout(flashTimer.current)
      setFlash(id)
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS)
    },
  }
}
