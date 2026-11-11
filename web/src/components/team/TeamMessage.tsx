// One message of a Team thread (#370), a bubble as in the session sheet: this board's on the right
// in the accent, the others' on the left. Over its text: the sender's name when it opens a group in
// a thread of several people, the agent's mark when an agent wrote it (its session, whose board),
// and the quote of the message it answers, which scrolls to it. Under it: the time, its full date
// on hover, and for this board's own how far it got. Hover or focus shows Reply; on a touch screen
// a long press shows the full date with Reply.
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { delivery, type ThreadLine } from '../../models/team.ts'
import { agentMark, bubbleTime, deliveryOf, fullWhen, type Quote, senderName, toneOf } from '../../models/team-chat.ts'
import { classNames } from '../class-names.ts'
import { MessageText } from '../sheet/MessageText.tsx'
import { TeamFile } from './TeamFile.tsx'

/** How long a touch holds before it counts as a long press (ms), and how far it may wander (px). */
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP = 10

export interface TeamMessageProps {
  line: ThreadLine
  /** It opens its sender's group. */
  first: boolean
  /** It closes its sender's group. */
  last: boolean
  /** The sender's name over a group (a thread of several people). */
  named: boolean
  quote: Quote | null
  /** Just jumped to from a quote: it lights up once. */
  flash?: boolean
  /** Reply to it; absent: no Reply (held, or nothing may be sent). */
  onReply?: ((id: string) => void) | undefined
  onQuote(id: string): void
}

export function TeamMessage({ line, first, last, named, quote, flash, onReply, onQuote }: TeamMessageProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const press = useLongPress(() => setOpen(true))
  const agent = agentMark(line, t)
  const when = fullWhen(line.ts, t)
  return (
    <div
      className={classNames(
        'team-msg',
        line.dir,
        first && 'first',
        last && 'last',
        agent && 'agent',
        line.held && 'held',
        flash && 'flash',
        open && 'open',
      )}
      data-line={line.id}
    >
      {named && first && line.dir === 'in' && (
        <div className={`team-msg-name tone-${toneOf(line.from ?? line.who ?? '')}`}>{senderName(line, t)}</div>
      )}
      <div className="team-msg-row">
        <div className="team-bubble" {...press.handlers}>
          {agent && (
            <div className="team-agent-mark" title={t('team.agentMark')}>
              <AgentGlyph />
              <code>{agent.session}</code>
              <span>{agent.board}</span>
              {line.pressed && <span>{t('team.pressed')}</span>}
            </div>
          )}
          {quote && <QuoteView quote={quote} onQuote={onQuote} />}
          {line.text === null ? (
            <p className="team-held-text">{t('team.heldText')}</p>
          ) : (
            (line.text !== '' || !line.file) && <Text text={line.text} />
          )}
          {line.file && line.text !== null && <TeamFile file={line.file} />}
          <span className="team-msg-foot">
            <time dateTime={line.ts} title={when}>
              {bubbleTime(line.ts, t)}
            </time>
            <Delivery line={line} />
          </span>
        </div>
        {onReply && (
          <button
            type="button"
            className="team-icon-button team-msg-reply"
            aria-label={t('team.reply')}
            title={t('team.reply')}
            onClick={() => onReply(line.id)}
          >
            <ReplyGlyph />
          </button>
        )}
      </div>
      {open && (
        <div className="team-msg-when">
          <span>{when}</span>
          {onReply && (
            <button
              type="button"
              className="mini"
              onClick={() => {
                setOpen(false)
                onReply(line.id)
              }}
            >
              {t('team.reply')}
            </button>
          )}
          <button type="button" className="mini" onClick={() => setOpen(false)}>
            {t('team.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}

/** A message's text, drawn again only when it changes: a key typed in the box leaves it alone. */
const Text = memo(function Text({ text }: { text: string }) {
  return <MessageText text={text} />
})

/** The message a reply answers: its sender and a line of it; a click goes there. Not found: said so, not a link. */
export function QuoteView({ quote, onQuote }: { quote: Quote; onQuote(id: string): void }) {
  const t = useT()
  if (!quote.found)
    return (
      <div className="team-quote gone" data-quote={quote.id}>
        <span>{t('team.quoteGone')}</span>
      </div>
    )
  return (
    <button
      type="button"
      className="team-quote"
      data-quote={quote.id}
      title={t('team.quoteJump')}
      onClick={() => onQuote(quote.id)}
    >
      <b>{quote.who}</b>
      <span>{quote.text ?? t('team.heldText')}</span>
    </button>
  )
}

/**
 * How far a message of this board's got: a clock while queued, a tick delivered, two received;
 * expired or refused in words. A team post shows its slowest copy and names every member's.
 */
function Delivery({ line }: { line: ThreadLine }) {
  const t = useT()
  const state = deliveryOf(line)
  if (!state) return null
  const all = line.receipts?.length
    ? line.receipts.map(r => `${r.name}: ${delivery(r.state, undefined, t)}`).join(', ')
    : delivery(state, line.code, t)
  if (state === 'refused' || state === 'expired')
    return (
      <span className="team-delivery bad" data-state={state} title={all}>
        {delivery(state, line.code, t)}
      </span>
    )
  return (
    <span className="team-delivery" data-state={state} role="img" aria-label={all} title={all}>
      <svg viewBox="0 0 16 12" aria-hidden="true">
        {state === 'queued' ? (
          <>
            <circle cx="8" cy="6" r="4.5" />
            <path d="M8 3.6V6l1.6 1.2" />
          </>
        ) : state === 'delivered' ? (
          <path d="M3.5 6.2l2.6 2.6 5.4-5.6" />
        ) : (
          <path d="M1.5 6.2l2.6 2.6 5.4-5.6M7.6 8.6l.2.2 5.4-5.6" />
        )}
      </svg>
    </span>
  )
}

/** A touch held still for a moment; a mouse or a pen is not one. */
function useLongPress(onPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: let go of a pending press once, when the message leaves
  useEffect(() => clear, [])
  return {
    handlers: {
      onPointerDown(e: ReactPointerEvent) {
        if (e.pointerType !== 'touch') return
        clear()
        fired.current = false
        start.current = { x: e.clientX, y: e.clientY }
        timer.current = setTimeout(() => {
          fired.current = true
          timer.current = null
          onPress()
        }, LONG_PRESS_MS)
      },
      onPointerMove(e: ReactPointerEvent) {
        const s = start.current
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      // The long press is the board's: the browser's own menu does not come up over it.
      onContextMenu(e: ReactMouseEvent) {
        if (fired.current) e.preventDefault()
      },
    },
  }
}

function AgentGlyph() {
  return (
    <svg className="team-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
    </svg>
  )
}

function ReplyGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 4L2.5 8l4 4M3 8h6.5a4 4 0 014 4v.5" />
    </svg>
  )
}
