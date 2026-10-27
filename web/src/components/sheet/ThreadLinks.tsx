// The thread's lines that work with others (the old page's app.js linkLine, peerBubble, whoHTML):
// a subagent, fork or workflow a call started (it opens the helper, with its status and clock),
// a message sent to another session or a teammate (it opens to the whole text), a session started
// with spawn-agent; and another session's or a teammate's message, a bubble with their name. In a
// helper's own conversation (the helpers window) what its session asked is the other side. An
// agent's or a workflow's report has "Conversation" beside it.
import type { MouseEvent, ReactNode } from 'react'
import type { PublicHelper, WorkflowRun } from '../../../../src/core/helpers.ts'
import { inPane } from '../../../../src/core/links.ts'
import type { TaskNotice } from '../../../../src/core/notices.ts'
import type { PeerTurn, ToolTurn, UserTurn } from '../../../../src/core/transcript.ts'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { findHelper, helperTitle, sessionByName, took } from '../../models/helper-model.ts'
import { markdown } from '../../models/markdown.ts'
import { clockText } from '../../models/sheet.ts'
import { HelperIcon, OutGlyph, PeerGlyph, SpawnedGlyph } from '../helpers/glyphs.tsx'
import { HelperTime, KindIcon, StatusMark } from '../helpers/HelperRows.tsx'
import { ChevGlyph } from '../icons.tsx'
import { MessageText } from './MessageText.tsx'

/** What the lines that work with others lead to, and where a click on one goes. */
export interface ThreadLinks {
  /** The session's helpers and workflow runs (its sheet's detail). */
  helpers: readonly PublicHelper[]
  workflows: readonly WorkflowRun[]
  /** The board's sessions. */
  items: readonly Item[]
  /** A helper's conversation, grown from `el`. */
  onHelper?: (id: string, el: HTMLElement) => void
  /** A workflow run's agents in the list, grown from `el`. */
  onRun?: (id: string, el: HTMLElement) => void
  /** Another session. */
  onSession?: (key: string) => void
  /** A long message opened or folded again: the thread changed height where the reader is. */
  onResize?: (() => void) | undefined
}

export const NO_LINKS: ThreadLinks = { helpers: [], workflows: [], items: [] }

/** The session the thread is of: its name, for "main" and the task in a helper's conversation. */
export type ThreadItem = Partial<Pick<Item, 'key' | 'name'>>

/** A helper's own conversation: its status says whether its last call still runs. */
export type ThreadHelper = { status: string } | null | undefined

/** A link inside a line that folds open (a message sent, a report) opens, not the fold. */
const go = (open: ((el: HTMLElement) => void) | undefined) => (e: MouseEvent<HTMLElement>) => {
  e.preventDefault()
  open?.(e.currentTarget)
}

interface WhoProps {
  name: string
  item: ThreadItem
  helper: ThreadHelper
  links: ThreadLinks
  /** The session on the other end, when the server knew it by its pipe. */
  sessionKey?: string | null | undefined
}

/** A name in the thread that leads somewhere: a session on the board, a teammate, or just the name. */
function Who({ name, item, helper, links, sessionKey = null }: WhoProps) {
  const t = useT()
  // In a helper's own conversation, its session goes by "main" or "team-lead".
  if (helper && ['main', 'team-lead'].includes(name)) return <b>{item.name ?? name}</b>
  // A reply to a message pipe whose session is gone: no name to give.
  if (!name && !sessionKey) return <b>{t('thread.anotherSession')}</b>
  // The session's own helper goes by that name first (a teammate, a named agent), then a session.
  const mate = !sessionKey && findHelper(links.helpers, { name })
  if (mate)
    return (
      <button
        type="button"
        className="who"
        data-helper={mate.id}
        title={t('helpers.open')}
        onClick={go(el => links.onHelper?.(mate.id, el))}
      >
        {mate.name || helperTitle(mate)}
      </button>
    )
  const session =
    (sessionKey && links.items.find(i => i.key === sessionKey)) || sessionByName(links.items, name, item.key ?? null)
  if (session) return <SessionButton session={session} links={links} />
  return <b>{name}</b>
}

function SessionButton({ session, links }: { session: Item; links: ThreadLinks }) {
  const t = useT()
  return (
    <button
      type="button"
      className="who"
      data-session={session.key}
      title={t('rel.open', { name: session.name })}
      onClick={go(() => links.onSession?.(session.key))}
    >
      {session.name}
    </button>
  )
}

/** A text with a name in its middle ("To {name}"), the name drawn as `who`. */
function Around({ text, who }: { text: string; who: ReactNode }) {
  const [before, after] = text.split('\u0000')
  return (
    <>
      {before}
      {who}
      {after ?? ''}
    </>
  )
}

export interface LinkLineProps {
  turn: ToolTurn
  item: ThreadItem
  helper: ThreadHelper
  links: ThreadLinks
}

/** A call that works with others, as a line of its own. */
export function LinkLine({ turn: m, item, helper, links }: LinkLineProps) {
  const t = useT()
  const when = <span className="when">{clockText(m.at, t)}</span>
  if (m.helper) {
    const h = findHelper(links.helpers, { id: m.helper.id, tool: m.id })
    const kind = h?.kind ?? m.helper.kind
    const title = h ? helperTitle(h) : m.detail || m.helper.name || m.helper.type
    const name = h?.name ?? m.helper.name
    const sub = [
      h?.type ?? m.helper.type,
      name !== title ? name : '',
      t((h ? h.background : m.helper.background) ? 'helpers.background' : 'helpers.foreground'),
    ]
      .filter(Boolean)
      .join(' · ')
    const line = (
      <>
        <KindIcon kind={kind} color={h?.color} />
        <span className="link-text">
          <span className="link-title">{t('thread.helper', { kind: t(`helpers.kind.${kind}`), title })}</span>
          {sub && (
            <>
              {' '}
              <small>{sub}</small>
            </>
          )}
        </span>
        {h ? (
          <>
            <HelperTime startedAt={h.startedAt} status={h.status} ms={took(h)} />
            <StatusMark status={h.status} />
          </>
        ) : (
          !m.done && <StatusMark status="running" />
        )}
      </>
    )
    return h ? (
      <button
        type="button"
        className="link-line"
        data-helper={h.id}
        title={t('helpers.open')}
        onClick={go(el => links.onHelper?.(h.id, el))}
      >
        {line}
      </button>
    ) : (
      <div className="link-line">
        {line}
        {when}
      </div>
    )
  }
  if (m.workflow) {
    const flow = m.workflow
    const w = links.workflows.find(x => x.id === flow.run)
    const line = (
      <>
        <KindIcon kind="workflow" />
        <span className="link-text">
          <span className="link-title">{t('thread.workflow', { name: w?.name || flow.name || flow.run })}</span>
          {!!w?.agents && (
            <>
              {' '}
              <small>{t('helpers.agents', { n: w.agents })}</small>
            </>
          )}
        </span>
        {w ? <StatusMark status={w.status} /> : !m.done && <StatusMark status="running" />}
      </>
    )
    return w ? (
      <button
        type="button"
        className="link-line"
        data-run-open={w.id}
        title={t('helpers.open')}
        onClick={go(el => links.onRun?.(w.id, el))}
      >
        {line}
      </button>
    ) : (
      <div className="link-line">
        {line}
        {when}
      </div>
    )
  }
  if (m.spawn) {
    const spawn = m.spawn
    const target = links.items.find(x => inPane(x, spawn.pane) && [x.name, x.autoName].includes(spawn.name)) ?? null
    const name = target ? <SessionButton session={target} links={links} /> : <b>{spawn.name || '…'}</b>
    return (
      <div className={spawn.failed ? 'link-line failed' : 'link-line'}>
        <span className="h-icon k-session">
          <SpawnedGlyph />
        </span>
        <span className="link-text">
          <Around text={t(spawn.failed ? 'thread.spawnFailed' : 'thread.spawn', { name: '\u0000' })} who={name} />
        </span>
        {!m.done && <StatusMark status="running" />}
        {when}
      </div>
    )
  }
  if (!m.send) return null
  // A message to another session or a teammate: its first words in the line, the whole of it inside.
  const send = m.send
  const line = (
    <>
      <span className="h-icon k-session">
        <OutGlyph />
      </span>
      <span className="link-text">
        <Around
          text={t('thread.sent', { name: '\u0000' })}
          who={<Who name={send.to} item={item} helper={helper} links={links} sessionKey={send.key} />}
        />
        {send.summary && (
          <>
            {' '}
            <small>{send.summary}</small>
          </>
        )}
      </span>
      {when}
    </>
  )
  if (!send.text) return <div className="link-line">{line}</div>
  return (
    <details className="link-line sent" data-i={`sent-${m.id ?? ''}`}>
      <summary>
        {line}
        <ChevGlyph />
      </summary>
      <div className="notice-body">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
        <div className="md" dangerouslySetInnerHTML={{ __html: markdown(send.text) }} />
      </div>
    </details>
  )
}

/**
 * "Conversation" on a background task's notice: an agent that reported back opens its helper, a
 * workflow its run (it reports under its task id, which its run file keeps). Nothing for others.
 */
export function NoticeOpen({ notice, links }: { notice: TaskNotice; links: ThreadLinks }) {
  const t = useT()
  const to = noticeTarget(notice, links)
  if (!to) return null
  const data = { [to.attr]: to.id }
  return (
    <button
      type="button"
      className="notice-open"
      {...data}
      title={t('helpers.open')}
      onClick={go(el => to.open?.(to.id, el))}
    >
      {t('notice.open')}
    </button>
  )
}

/** Where a notice's "Conversation" leads: the attribute that names it, its id, and what opens it. */
interface NoticeTarget {
  attr: 'data-helper' | 'data-run-open'
  id: string
  open: ThreadLinks['onHelper']
}

function noticeTarget(m: TaskNotice, links: ThreadLinks): NoticeTarget | null {
  const agent = m.kind === 'agent' && m.id ? findHelper(links.helpers, { id: m.id }) : null
  if (agent) return { attr: 'data-helper', id: agent.id, open: links.onHelper }
  const run = m.kind === 'workflow' && m.id ? links.workflows.find(w => w.taskId === m.id) : null
  if (run) return { attr: 'data-run-open', id: run.id, open: links.onRun }
  return null
}

export interface PeerBubbleProps {
  turn: PeerTurn | UserTurn
  item: ThreadItem
  helper: ThreadHelper
  links: ThreadLinks
}

/** Another session's or a teammate's message; in a helper's conversation, what its session asked. */
export function PeerBubble({ turn: m, item, helper, links }: PeerBubbleProps) {
  const t = useT()
  const asked = !!helper && m.role === 'user'
  const peer = m.role === 'peer' ? m : null
  const from = asked ? (
    <b>{item.name ?? ''}</b>
  ) : (
    <Who name={peer?.from ?? ''} item={item} helper={helper} links={links} sessionKey={peer?.key} />
  )
  return (
    <div className={peer?.team ? 'msg peer team' : 'msg peer'}>
      <div className="peer-from">
        {peer?.team ? <HelperIcon name="teammate" /> : <PeerGlyph />}
        <span>
          <Around text={t(asked ? 'thread.task' : 'thread.peer', { name: '\u0000' })} who={from} />
        </span>
        {peer?.summary && <small>{peer.summary}</small>}
      </div>
      <MessageText text={m.text} cut={m.cut} onResize={links.onResize} />
      <span className="when">{clockText(m.at, t)}</span>
    </div>
  )
}
