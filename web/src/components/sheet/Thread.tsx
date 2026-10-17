// The conversation: messages as bubbles (Markdown, with previews of the images sent from the
// board), runs of tool calls folded into one line that opens to show them, and the question forms
// the session asked with their answers. Paths in it are candidates the file chips take up
// (data-path; components/sheet/Sheet.tsx hands them over after every draw).
import type { ConversationTurn } from '../../../../src/core/transcript.ts'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { markdown } from '../../models/markdown.ts'
import { clockText } from '../../models/sheet.ts'
import { type AskTurn, askState, type ThreadPart, threadParts, uploadThumbs } from '../../models/thread.ts'
import { classNames } from '../class-names.ts'
import { ChevGlyph, SpinGlyph } from '../icons.tsx'

export interface ThreadProps {
  conversation: readonly ConversationTurn[]
  item: Pick<Item, 'column' | 'status'>
}

export function Thread({ conversation, item }: ThreadProps) {
  const t = useT()
  const parts = threadParts(conversation, item, t)
  return parts.map((part, n) => <ThreadTurn key={keyOf(part, n)} part={part} />)
}

/** A fold keeps its place among the folds (a redraw leaves the one open that was); the rest go by order. */
const keyOf = (part: ThreadPart, n: number) => (part.kind === 'tools' ? `tools-${part.i}` : `${part.kind}-${n}`)

function ThreadTurn({ part }: { part: ThreadPart }) {
  const t = useT()
  if (part.kind === 'ask') return <AskedTurn turn={part.turn} live={part.live} />
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
