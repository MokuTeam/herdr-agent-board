// The conversation: messages as bubbles (Markdown, with previews of the images sent from the
// board), runs of tool calls folded into one line that opens to show them, the question forms
// the session asked with their answers, and background tasks reporting back and board reminders
// as quiet lines. A call that works with others is a line of its own, and another session's or a
// teammate's message a bubble with their name (ThreadLinks.tsx). Paths in it are candidates the
// file chips take up (data-path; components/sheet/Sheet.tsx hands them over after every draw).
// The helpers window draws a helper's own conversation with it too. At its foot (Waiting): the
// user's messages Claude has not taken in yet, and the board's own on their way or not sent.
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { isCall, isReminder, isTask } from '../../../../src/core/notices.ts'
import type { QueuedPrompt } from '../../../../src/core/queue.ts'
import type { ConversationTurn, NoticeTurn } from '../../../../src/core/transcript.ts'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { OutboxEntry } from '../../models/composer-session.ts'
import { markdown } from '../../models/markdown.ts'
import { noticeLine } from '../../models/notice.ts'
import { clockText } from '../../models/sheet.ts'
import { reducedMotion } from '../../models/spring.ts'
import { type AskTurn, askState, type ThreadPart, threadParts, uploadThumbs } from '../../models/thread.ts'
import { classNames } from '../class-names.ts'
import {
  AlarmGlyph,
  BoltGlyph,
  CheckGlyph,
  ChevGlyph,
  ClockGlyph,
  CrossGlyph,
  PhoneGlyph,
  SpinGlyph,
  StopGlyph,
} from '../icons.tsx'
import {
  LinkLine,
  NO_LINKS,
  NoticeOpen,
  PeerBubble,
  type ThreadHelper,
  type ThreadItem,
  type ThreadLinks,
} from './ThreadLinks.tsx'

export interface ThreadProps {
  conversation: readonly ConversationTurn[]
  item: Partial<Pick<Item, 'column' | 'status'>> & ThreadItem
  /** The session's helpers and the board, for the lines that work with others. */
  links?: ThreadLinks | undefined
  /** A helper's own conversation (the helpers window): what the session asked it is the other side. */
  helper?: ThreadHelper
}

export function Thread({ conversation, item, links = NO_LINKS, helper = null }: ThreadProps) {
  const t = useT()
  const parts = threadParts(conversation, item, t, { helper })
  const used = new Set<string>()
  return parts.map((part, n) => {
    // A task can report twice at one time under one id: the second keeps its own key.
    const wanted = keyOf(part, n)
    const key = used.has(wanted) ? `${wanted}-${n}` : wanted
    used.add(key)
    return <ThreadTurn key={key} part={part} item={item} links={links} helper={helper} />
  })
}

/**
 * A fold keeps its place among the folds, a notice that opens its task and time (a redraw leaves
 * the one open that was), a line that works with others its call; the rest go by order.
 */
function keyOf(part: ThreadPart, n: number): string {
  if (part.kind === 'tools') return `tools-${part.i}`
  if (part.kind === 'notice') return noticeId(part.turn) ?? `notice-${n}`
  if (part.kind === 'link') return `link-${part.turn.id ?? n}`
  return `${part.kind}-${n}`
}

/** The key a notice with something to open is kept open by: a task can report several times under one id. */
const noticeId = (m: NoticeTurn): string | null =>
  !isReminder(m) && m.detail ? `notice-${isTask(m) ? m.id : undefined}-${m.at}` : null

interface TurnProps {
  part: ThreadPart
  item: ThreadItem
  links: ThreadLinks
  helper: ThreadHelper
}

function ThreadTurn({ part, item, links, helper }: TurnProps) {
  const t = useT()
  if (part.kind === 'ask') return <AskedTurn turn={part.turn} live={part.live} />
  if (part.kind === 'link') return <LinkLine turn={part.turn} item={item} helper={helper} links={links} />
  if (part.kind === 'peer') return <PeerBubble turn={part.turn} item={item} helper={helper} links={links} />
  if (part.kind === 'notice') return <Notice turn={part.turn} links={links} />
  if (part.kind === 'message') {
    const { role, text, at } = part.turn
    return (
      <div className={`msg ${role}`}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
        <div className="md" dangerouslySetInnerHTML={{ __html: markdown(text) }} />
        <Thumbs text={text} />
        <span className="when">{clockText(at, t)}</span>
      </div>
    )
  }
  return (
    <details className="tools" data-i={part.i}>
      <summary>
        {part.live ? <SpinGlyph /> : <ChevGlyph />}
        <span>{part.summary}</span>
      </summary>
      {part.calls.map((call, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: calls have no id of their own; their order is theirs
        <div key={n} className={classNames('tool-line', !call.done && 'pending')}>
          <span className="t">{call.label}</span>
          <span className={classNames('d', !!call.path && 'fs-inline')} data-path={call.path || undefined}>
            {call.detail}
          </span>
        </div>
      ))}
    </details>
  )
}

/** Previews of the images a message names from the board's uploads. */
function Thumbs({ text }: { text: string }) {
  const thumbs = uploadThumbs(text)
  if (!thumbs.length) return null
  return (
    <div className="thumbs">
      {thumbs.map((s, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the same picture can be named twice; their order is theirs
        <a key={n} className="fs-inline" data-path={s.path} href={s.url} target="_blank" rel="noopener">
          <img src={s.url} alt="" loading="lazy" />
        </a>
      ))}
    </div>
  )
}

export interface WaitingProps {
  /** The session's queue: what Claude has not taken in yet (SessionDetail.queued). */
  queued: readonly QueuedPrompt[]
  /** The board's own messages on their way, not in the transcript yet, or not sent (useComposer). */
  own: readonly OutboxEntry[]
  onRetry?: ((id: string) => void) | undefined
  onEdit?: ((id: string) => void) | undefined
}

/**
 * The foot of the thread: the user's messages waiting in the session's queue, which Claude has
 * not taken in yet (typed in its terminal or sent from here), then the board's own on their way
 * or not sent. Quiet bubbles; once Claude has one, it is an ordinary bubble in the same place.
 */
export function Waiting({ queued, own, onRetry, onEdit }: WaitingProps) {
  const t = useT()
  return (
    <>
      {queued.map((m, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a queued message has no id; the queue keeps its order
        <div key={n} className="msg user waiting" title={t('queue.hint')}>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
          <div className="md" dangerouslySetInnerHTML={{ __html: markdown(m.text) }} />
          <Thumbs text={m.text} />
          <span className="when">
            <ClockGlyph />
            {t('queue.queued')}
          </span>
        </div>
      ))}
      {own.map(e => (
        <OwnBubble key={e.id} entry={e} onRetry={onRetry} onEdit={onEdit} />
      ))}
    </>
  )
}

// A message just sent rises into the thread out of the box it was written in, once (for the page).
const arrived = new Set<string>()

/** One of the board's own messages: "Sending…", or "Not sent" with why, Retry and Edit. */
function OwnBubble({ entry: e, onRetry, onEdit }: { entry: OutboxEntry } & Omit<WaitingProps, 'queued' | 'own'>) {
  const t = useT()
  const bubble = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bubble.current
    if (!el || arrived.has(e.id)) return
    arrived.add(e.id)
    el.animate(
      reducedMotion.matches
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(14px) scale(0.98)' },
            { opacity: 1, transform: 'none' },
          ],
      { duration: reducedMotion.matches ? 160 : 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
  }, [e.id])
  const failed = e.state === 'failed'
  return (
    <div ref={bubble} className={classNames('msg user waiting', failed && 'failed')} data-out={e.id}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
      <div className="md" dangerouslySetInnerHTML={{ __html: markdown(e.full) }} />
      <Thumbs text={e.full} />
      {failed ? (
        <>
          <span className="when">
            <b>{t('queue.failed')}</b>
            {e.error ? ` · ${e.error}` : ''}
          </span>
          <span className="out-actions">
            <button type="button" data-out-retry={e.id} onClick={() => onRetry?.(e.id)}>
              {t('detail.retry')}
            </button>
            <button type="button" data-out-edit={e.id} onClick={() => onEdit?.(e.id)}>
              {t('queue.edit')}
            </button>
          </span>
        </>
      ) : (
        <span className="when">{t('queue.sending')}</span>
      )}
    </div>
  )
}

/** A question form in the conversation: what was asked and what was answered. */
function AskedTurn({ turn, live }: { turn: AskTurn; live: boolean }) {
  const t = useT()
  const state = askState(turn, live)
  return (
    <div className="msg assistant qa-msg">
      <div className="qa-asked">{t('qa.thread.asked')}</div>
      {turn.ask.map((q, n) => {
        const answer = turn.answers?.[n]
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the form's questions in their order
          <div key={n} className="qa-line">
            {q.header && <span className="qa-tag">{q.header}</span>}
            <span className="qa-line-q">{q.question}</span>
            {answer && <span className="qa-ans">{answer}</span>}
          </div>
        )
      })}
      {state && <div className="qa-wait">{t(state === 'waiting' ? 'qa.thread.waiting' : 'qa.thread.closed')}</div>}
      <span className="when">{clockText(turn.at, t)}</span>
    </div>
  )
}

const MARKS = { ok: CheckGlyph, fail: CrossGlyph, stop: StopGlyph } as const

/**
 * A background task reporting back or a board reminder: a quiet line in the thread, not the
 * user's bubble. An agent's report or a monitor's lines open from it; a command's output file is
 * a click away, and so is an agent's or a workflow's whole conversation.
 */
function Notice({ turn: m, links }: { turn: NoticeTurn; links: ThreadLinks }) {
  const t = useT()
  const { text, sub, tone } = noticeLine(m, t)
  const reminder = isReminder(m)
  const call = isCall(m) ? m : null
  const Mark = tone === 'info' ? (call ? PhoneGlyph : reminder ? AlarmGlyph : BoltGlyph) : MARKS[tone]
  const task = isTask(m) ? m : null
  // What opens from the line: an agent's report, a monitor's lines, a call's results.
  const detail = task?.detail || call?.detail || ''
  const line: ReactNode = (
    <>
      <span className="notice-mark">
        <Mark />
      </span>
      <span className="notice-text" title={task?.summary || undefined}>
        {text}
        {sub && (
          <>
            {' '}
            <small>{sub}</small>
          </>
        )}
      </span>
      {task?.file && !task.detail && (
        <span className="notice-file fs-inline" data-path={task.file}>
          {t('notice.output')}
        </span>
      )}
      {task && <NoticeOpen notice={task} links={links} />}
      <span className="when">{clockText(m.at, t)}</span>
    </>
  )
  if (!detail) return <div className={`notice ${tone}`}>{line}</div>
  return (
    <details className={`notice ${tone}`} data-i={noticeId(m) ?? undefined}>
      <summary>
        {line}
        <ChevGlyph />
      </summary>
      <div className="notice-body">
        {/* An agent's report and a call's results are markdown (its paths become file chips); a
            monitor's lines and a tool's result are kept as they came. */}
        {call || task?.kind === 'agent' || task?.kind === 'workflow' ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
          <div className="md" dangerouslySetInnerHTML={{ __html: markdown(detail) }} />
        ) : (
          <pre>{detail}</pre>
        )}
      </div>
    </details>
  )
}
