// The team panel (#231), out of Settings → Team… or the head's Team button, while the payload
// carries `teamRev`; a messenger since #370. A wide panel shows two columns, the conversations on
// the left (TeamList.tsx) and the one on show on the right (TeamThread.tsx); a narrow one (a
// docked panel, a phone) shows one at a time, the list first, as #355 did. People and agents
// (TeamPeople.tsx: the roster and keys, the passkeys, the switches) takes the right column, or the
// screen, the same way. The draft and the message it answers are kept per thread while the page
// lives (the panel stays mounted while it is closed, SidePanels.tsx).
//
// The data is hooks/useTeam.ts's; the board sends only its revision.
import { useEffect, useRef, useState } from 'react'
import { type NewTopic, type SendFile, useTeam } from '../../hooks/useTeam.ts'
import { uploadPlace, useThreadFiles } from '../../hooks/useThreadFiles.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { Attachment } from '../../models/composer.ts'
import type { AgentsChange, AgentsView, TeamView, ThreadLine, ThreadView, Welcome } from '../../models/team.ts'
import { firstUnread } from '../../models/team-chat.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'
import { TeamList } from './TeamList.tsx'
import { TeamPeople } from './TeamPeople.tsx'
import { TeamThread } from './TeamThread.tsx'

export interface TeamPanelProps {
  open: boolean
  onClose(): void
  /** A thread a notification's click asked for (#355): it is shown once, then onFocused. */
  focus?: string | null
  onFocused?(): void
}

export function TeamPanel({ open, onClose, focus, onFocused }: TeamPanelProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const team = useTeam(open)
  const { select } = team
  const drafts = useThreadDrafts()
  const files = useThreadFiles()
  const [topic, setTopic] = useState<NewTopic | null>(null)
  const [people, setPeople] = useState(false)
  const [sending, setSending] = useState(false)
  // Each opening of the panel is a visit: what came in meanwhile is new again (#370).
  const [visit, setVisit] = useState(0)
  useEffect(() => {
    if (open) setVisit(v => v + 1)
  }, [open])
  const key = team.selected ?? ''
  const show = (k: string | null) => {
    setTopic(null)
    setPeople(false)
    select(k)
  }
  useEffect(() => {
    if (!focus) return
    setTopic(null)
    setPeople(false)
    select(focus)
    onFocused?.()
  }, [focus, select, onFocused])
  // A channel starts in the team chat's general: a title, its members, the first message (#355).
  const newChannel = () => {
    setPeople(false)
    select('team/general')
    setTopic({ title: '', members: [] })
  }
  const send = async () => {
    const draft = drafts.text(key)
    // Each file goes as a message of its own (#371), the first with the text, the reply and the topic.
    const attached = files.of(key).filter(f => f.status === 'done')
    if (files.of(key).some(f => f.status === 'uploading')) return
    if ((!draft.trim() && !attached.length) || (topic && (!topic.title.trim() || topic.members?.length === 0))) return
    setSending(true)
    const replyTo = topic ? undefined : (drafts.replyTo(key) ?? undefined)
    const newTopic = topic
      ? {
          title: topic.title.trim(),
          ...(topic.link?.trim() && { link: topic.link.trim() }),
          ...(topic.members && { members: topic.members }),
        }
      : undefined
    const steps: { text: string; file?: SendFile }[] = attached.length
      ? attached.map((f, i) => ({ text: i === 0 ? draft : '', file: { upload: uploadPlace(f.path), name: f.name } }))
      : [{ text: draft }]
    let sent = 0
    for (const [i, step] of steps.entries()) {
      const ok = await team.send(step.text, i === 0 ? newTopic : undefined, i === 0 ? replyTo : undefined, step.file)
      if (!ok) break
      sent++
    }
    if (sent > 0) {
      drafts.clear(key)
      setTopic(null)
      // What went is taken off; a file whose send was refused stays, to try again or remove.
      files.clear(
        key,
        attached.slice(0, sent).map(f => f.id),
      )
    }
    setSending(false)
  }
  return (
    <Panel
      id="team-sheet"
      kind="team"
      measure="full"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('team.title')}</h2>
          <p className="sheet-meta">{t('team.about')}</p>
        </>
      }
    >
      <TeamBody
        view={team.view}
        threads={team.threads}
        selected={team.selected}
        thread={team.thread}
        lines={team.lines}
        unread={team.unread}
        agents={team.agents}
        draft={drafts.text(key)}
        topic={topic}
        replyTo={drafts.replyTo(key)}
        people={people}
        visit={visit}
        disabled={!canEdit || sending}
        onSelect={show}
        onPeople={on => {
          setPeople(on)
          if (on) {
            setTopic(null)
            select(null)
          }
        }}
        onTrust={peer => void team.trust(peer)}
        onSendDraft={id => void team.sendDraft(id)}
        onDiscardDraft={id => void team.discardDraft(id)}
        onDraft={text => drafts.setText(key, text)}
        onReply={id => drafts.setReply(key, id)}
        onTopic={setTopic}
        onSend={() => void send()}
        files={files.of(key)}
        onAddFiles={given => files.add(key, given)}
        onRemoveFile={id => files.remove(key, id)}
        onMute={(k, muted) => void team.mute(k, muted)}
        onAgents={change => void team.setAgents(change)}
        pending={team.pending}
        onWelcome={w => void team.welcome(w)}
        onNewChannel={newChannel}
        onAddMembers={(k, peers) => void team.addMembers(k, peers)}
      />
    </Panel>
  )
}

/**
 * What is being written in each thread (#370), by the thread's key, while the page lives: the text
 * and the line it answers. Another thread on show keeps its own; a send clears the one it was from.
 */
export function useThreadDrafts() {
  const [all, setAll] = useState<Record<string, { text?: string; replyTo?: string }>>({})
  const of = (key: string) => (Object.hasOwn(all, key) ? all[key] : undefined)
  return {
    text: (key: string): string => of(key)?.text ?? '',
    replyTo: (key: string): string | null => of(key)?.replyTo ?? null,
    setText: (key: string, text: string) => setAll(d => ({ ...d, [key]: { ...d[key], text } })),
    setReply: (key: string, id: string | null) =>
      setAll(d => {
        const { replyTo: _, ...rest } = d[key] ?? {}
        return { ...d, [key]: id ? { ...rest, replyTo: id } : rest }
      }),
    clear: (key: string) => setAll(({ [key]: _, ...rest }) => rest),
  }
}

export interface TeamBodyProps {
  /** GET /api/team's answer; null while the board is asked. */
  view: TeamView | null
  threads: ThreadView[]
  /** The key of the thread on show; null: none (the list, on a narrow panel). */
  selected: string | null
  /** The thread on show as the board keeps it; null while nothing was written in it. */
  thread: ThreadView | null
  lines: ThreadLine[]
  /** Each thread's unread messages (#355); none given: none shown. */
  unread?: Record<string, number>
  /** The owner's switches; null (a remote page): not shown, and the team chat's mute neither. */
  agents: AgentsView | null
  draft: string
  /** A new topic being written in the thread's scope; null: a message in the thread on show. */
  topic: NewTopic | null
  /** The line the message being written answers (#370); none: a plain message. */
  replyTo?: string | null
  /** People and agents on show instead of a thread (#370). */
  people?: boolean
  /** Counts the panel's openings: a thread shown again in a new one opens at what is new since (#370). */
  visit?: number
  disabled: boolean
  onSelect(key: string | null): void
  onPeople?(open: boolean): void
  onTrust(peer: string): void
  /** Press Send on an agent's draft: it goes out marked as an agent request. */
  onSendDraft(id: string): void
  onDiscardDraft(id: string): void
  onDraft(text: string): void
  /** Reply to a line of the thread on show, or let go of the reply (null). */
  onReply?(id: string | null): void
  onTopic(topic: NewTopic | null): void
  onSend(): void
  onMute(key: string, muted: boolean): void
  onAgents(change: AgentsChange): void
  /** Who joined and waits for a welcome (#355); none given: none offered. */
  pending?: string[]
  onWelcome?(w: Welcome): void
  /** Start a channel: the team chat's general with a new topic for some members (#355). */
  onNewChannel?(): void
  /** More members for a channel this board started (#355). */
  onAddMembers?(key: string, peers: string[]): void
  /** The files that go with the next message in the thread on show (#371). */
  files?: readonly Attachment[]
  onAddFiles?(files: File[]): void
  onRemoveFile?(id: number): void
}

/** The list and the thread on show (or People and agents); which of them a narrow panel shows is `data-pane`. */
export function TeamBody(props: TeamBodyProps) {
  const t = useT()
  const { view, selected, people = false, unread = {}, pending = [], visit = 0 } = props
  const unreadFrom = useUnreadFrom(selected, visit, unread, props.lines)
  if (!view) return <div className="sheet-body team-body" />
  const pane = selected ? 'thread' : people ? 'people' : 'list'
  return (
    <div className="sheet-body team-body" data-pane={pane}>
      <TeamList
        view={view}
        threads={props.threads}
        selected={selected}
        unread={unread}
        agents={props.agents}
        pending={pending}
        disabled={props.disabled}
        onSelect={props.onSelect}
        onPeople={() => props.onPeople?.(true)}
        {...(props.onWelcome && { onWelcome: props.onWelcome })}
        {...(props.onNewChannel && { onNewChannel: props.onNewChannel })}
      />
      <div className="team-main">
        {selected ? (
          <TeamThread
            key={`${visit}:${selected}`}
            view={view}
            selected={selected}
            thread={props.thread}
            lines={props.lines}
            agents={props.agents}
            unreadFrom={unreadFrom}
            draft={props.draft}
            topic={props.topic}
            replyTo={props.replyTo ?? null}
            disabled={props.disabled}
            onBack={() => props.onSelect(null)}
            onTrust={props.onTrust}
            onSendDraft={props.onSendDraft}
            onDiscardDraft={props.onDiscardDraft}
            onDraft={props.onDraft}
            onTopic={props.onTopic}
            onSend={props.onSend}
            onMute={props.onMute}
            onReply={id => props.onReply?.(id)}
            {...(props.onAddMembers && { onAddMembers: props.onAddMembers })}
            {...(props.files && { files: props.files })}
            {...(props.onAddFiles && { onAddFiles: props.onAddFiles })}
            {...(props.onRemoveFile && { onRemoveFile: props.onRemoveFile })}
          />
        ) : people ? (
          <TeamPeople
            view={view}
            threads={props.threads}
            agents={props.agents}
            pending={pending}
            disabled={props.disabled}
            onBack={() => props.onPeople?.(false)}
            onSelect={props.onSelect}
            onTrust={props.onTrust}
            onAgents={props.onAgents}
          />
        ) : (
          <p className="hint team-pick-hint">{t('team.pickThread')}</p>
        )}
      </div>
    </div>
  )
}

/**
 * Where the "new messages" line goes in the thread on show: its first unread line as it was when
 * the thread opened in this visit of the panel. It stays on that line while the thread is read
 * (the count drops to 0) and while more comes in, until the list, another thread or a new visit.
 */
function useUnreadFrom(
  selected: string | null,
  visit: number,
  unread: Record<string, number>,
  lines: readonly ThreadLine[],
): string | null {
  const kept = useRef<{ at: string; id: string | null } | null>(null)
  const at = `${visit}:${selected ?? ''}`
  if (!selected) {
    kept.current = null
    return null
  }
  if (kept.current?.at !== at) {
    const id = firstUnread(
      lines.filter(l => l.dir !== 'draft'),
      unread[selected] ?? 0,
    )
    // Its lines come with its count: until they are here (a notification's click opens it before
    // the fetch) nothing is kept.
    if (!lines.length) return id
    kept.current = { at, id }
  }
  return kept.current.id
}
