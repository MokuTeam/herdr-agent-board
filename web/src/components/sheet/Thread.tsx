// The conversation: messages as bubbles (Markdown, with previews of the images sent from the
// board), runs of tool calls folded into one line that opens to show them, the question forms
// the session asked with their answers, and background tasks reporting back and board reminders
// as quiet lines. A call that works with others is a line of its own, and another session's or a
// teammate's message a bubble with their name (ThreadLinks.tsx). Paths in it are candidates the
// file chips take up (data-path; components/sheet/Sheet.tsx hands them over after every draw).
// The helpers window draws a helper's own conversation with it too.
import type { ReactNode } from 'react'
import { isReminder } from '../../../../src/core/notices.ts'
import type { ConversationTurn, NoticeTurn } from '../../../../src/core/transcript.ts'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { markdown } from '../../models/markdown.ts'
import { noticeLine } from '../../models/notice.ts'
import { clockText } from '../../models/sheet.ts'
import { type AskTurn, askState, type ThreadPart, threadParts, uploadThumbs } from '../../models/thread.ts'
import { classNames } from '../class-names.ts'
import { AlarmGlyph, BoltGlyph, CheckGlyph, ChevGlyph, CrossGlyph, SpinGlyph, StopGlyph } from '../icons.tsx'
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
const noticeId = (m: NoticeTurn): string | null => (!isReminder(m) && m.detail ? `notice-${m.id}-${m.at}` : null)

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
    const thumbs = uploadThumbs(text)
    return (
      <div className={`msg ${role}`}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
        <div className="md" dangerouslySetInnerHTML={{ __html: markdown(text) }} />
        {thumbs.length > 0 && (
          <div className="thumbs">
            {thumbs.map((s, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same picture can be named twice; their order is theirs
              <a key={n} className="fs-inline" data-path={s.path} href={s.url} target="_blank" rel="noopener">
                <img src={s.url} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        )}
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
  const Mark = tone === 'info' ? (reminder ? AlarmGlyph : BoltGlyph) : MARKS[tone]
  const task = reminder ? null : m
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
  if (!task?.detail) return <div className={`notice ${tone}`}>{line}</div>
  return (
    <details className={`notice ${tone}`} data-i={noticeId(m) ?? undefined}>
      <summary>
        {line}
        <ChevGlyph />
      </summary>
      <div className="notice-body">
        {/* An agent's report is markdown; a monitor's lines and a tool's result are kept as they came. */}
        {task.kind === 'agent' || task.kind === 'workflow' ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
          <div className="md" dangerouslySetInnerHTML={{ __html: markdown(task.detail) }} />
        ) : (
          <pre>{task.detail}</pre>
        )}
      </div>
    </details>
  )
}
