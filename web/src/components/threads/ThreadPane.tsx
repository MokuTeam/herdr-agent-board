// One thread in the panel (#392, docs/design/threads 10.3, 9.3): the head (back, the parent as a
// crumb, the link; the key and title; the status menu, the assignee, the lane; the summary), a
// proposed close with Confirm and Keep open (3.5), the sub-threads, the feed (status changes as
// quiet lines, entries as Team's bubbles, a question for the owner as a block) and Team's composer,
// whose words answer the open question (6.6) or go in as the owner's note.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api/client.ts'
import { useThreadFiles } from '../../hooks/useThreadFiles.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { ThreadLine } from '../../models/team.ts'
import type { Quote } from '../../models/team-chat.ts'
import {
  feedOf,
  isOwnerParty,
  partyLabel,
  STATUS_MENU,
  statusColor,
  type ThreadEntryView,
  type ThreadStatus,
  type ThreadView,
  threadHref,
} from '../../models/work-threads.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Attachments } from '../sheet/Attachments.tsx'
import { AttachButton } from '../team/AttachButton.tsx'
import { TeamComposer } from '../team/TeamComposer.tsx'
import { TeamMessage } from '../team/TeamMessage.tsx'
import { KeyText, MiniRow, StatusDot, statusWord, WhoChip } from './bits.tsx'

export interface ThreadPaneProps {
  view: ThreadView
  onOpen(key: string): void
  onBack(): void
}

const iso = (at: number) => new Date(at).toISOString()

/** An entry as Team's bubble takes it: the owner's on the right, everyone else's on the left. */
const lineOf = (e: ThreadEntryView): ThreadLine => ({
  id: e.id,
  dir: isOwnerParty(e.author) ? 'out' : 'in',
  text: e.text,
  ts: iso(e.at),
  ...(e.replyTo && { replyTo: e.replyTo }),
})

function Files({ entry }: { entry: ThreadEntryView }) {
  if (!entry.files?.length && !entry.links?.length) return null
  return (
    <div className="wt-files">
      {entry.files?.map(f => (
        <button type="button" key={f.ref} className="fs-chip wt-file" data-fs="file" data-abs={f.path}>
          {f.name}
          <small>{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</small>
        </button>
      ))}
      {entry.links?.map(l =>
        /^https?:\/\//i.test(l.url) ? (
          <a key={l.url} className="ext wt-link" href={l.url} target="_blank" rel="noopener noreferrer">
            {l.title || l.url}
          </a>
        ) : (
          <span key={l.url} className="wt-link">
            <KeyText text={l.url} />
          </span>
        ),
      )}
    </div>
  )
}

/** The mark over a session's or a peer's entry: who wrote it, and a session's opens its sheet. */
function Mark({ entry }: { entry: ThreadEntryView }) {
  return (
    <div className="team-agent-mark wt-mark">
      <WhoChip party={entry.author} />
    </div>
  )
}

export function ThreadPane({ view, onOpen, onBack }: ThreadPaneProps) {
  const t = useT()
  const { data, canEdit, toast } = useBoardContext()
  const { head } = view
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const files = useThreadFiles()
  const attached = files.of(head.key)
  const scroll = useRef<HTMLDivElement | null>(null)
  const feed = feedOf(head, view.entries, view.ask)
  // A close the agent proposed meanwhile is answered by Confirm or Keep open: the box adds a note.
  const asking = view.ask !== null && head.status === 'owner' && !head.proposed

  // A new entry, or another thread: the feed shows its end.
  const last = view.entries.at(-1)?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: another thread or a new entry is when to scroll, not what it reads
  useLayoutEffect(() => {
    const el = scroll.current
    if (el) el.scrollTop = el.scrollHeight
  }, [head.id, last])
  // biome-ignore lint/correctness/useExhaustiveDependencies: another thread is when the reply goes
  useEffect(() => setReply(null), [head.id])

  const write = async (body: Record<string, unknown>, done?: () => void) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.post(`/api/threads/${encodeURIComponent(head.key)}`, body)
      done?.()
      if (r.told === false) toast(t('wt.notTold', { why: String(r.why ?? '') }), true)
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setBusy(false)
    }
  }
  const send = () => {
    const text = draft.trim()
    const paths = attached.filter(f => f.status === 'done').map(f => f.path)
    if ((!text && !paths.length) || attached.some(f => f.status === 'uploading')) return
    const body = asking ? { op: 'answer', text } : { op: 'post', text, files: paths, ...(reply && { replyTo: reply }) }
    void write(body, () => {
      setDraft('')
      setReply(null)
      files.clear(head.key)
    })
  }
  const quote = (id: string): Quote | null => {
    const e = view.entries.find(x => x.id === id)
    return e
      ? { id, found: true, who: partyLabel(e.author, t('wt.you')), text: e.text.split('\n')[0] ?? '' }
      : { id, found: false, who: '', text: null }
  }
  const jump = (id: string) =>
    scroll.current?.querySelector(`[data-line="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })

  const sessions = (data?.items ?? []).filter(i => !i.call)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(threadHref(head.key, location.origin))
      toast(t('wt.copied'))
    } catch {
      toast(t('wt.copyFailed'), true)
    }
  }

  return (
    <div className="wt-thread" data-thread={head.key}>
      <header className="wt-head">
        <div className="wt-bar">
          <button
            type="button"
            className="team-icon-button wt-back"
            aria-label={t('wt.back')}
            title={t('wt.back')}
            onClick={onBack}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          {head.parentKey && (
            <span className="wt-crumb">
              <button type="button" onClick={() => onOpen(head.parentKey as string)}>
                {head.parentKey}
              </button>
              <span aria-hidden="true">›</span>
            </span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="team-icon-button"
            aria-label={t('wt.copyLink')}
            title={t('wt.copyLink')}
            onClick={copy}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />
            </svg>
          </button>
        </div>
        <h3 className="wt-title">
          <code>{head.key}</code>
          {head.title}
        </h3>
        <div className="wt-pills">
          <label className="wt-status" style={{ '--c': statusColor(head.status) }} title={t('wt.statusHint')}>
            <StatusDot status={head.status} />
            <span>{statusWord(head.status, t)}</span>
            <select
              aria-label={t('wt.statusHint')}
              value={head.status}
              disabled={!canEdit || busy}
              onChange={e => void write({ op: 'post', status: e.target.value as ThreadStatus })}
            >
              {STATUS_MENU.map(s => (
                <option key={s} value={s}>
                  {statusWord(s, t)}
                </option>
              ))}
            </select>
          </label>
          <span className="wt-assignee">
            <WhoChip party={head.assignee} />
            <select
              className="wt-assign"
              aria-label={t('wt.assignHint')}
              title={t('wt.assignHint')}
              value={head.assignee?.kind === 'session' ? head.assignee.key : ''}
              disabled={!canEdit || busy}
              onChange={e => {
                const item = sessions.find(i => i.key === e.target.value)
                void write({ op: 'set', assignee: item ? { key: item.key, name: item.name } : null })
              }}
            >
              <option value="">{t('wt.nobody')}</option>
              {head.assignee?.kind === 'session' &&
                !sessions.some(i => i.key === (head.assignee as { key: string }).key) && (
                  <option value={head.assignee.key}>{head.assignee.name}</option>
                )}
              {sessions.map(i => (
                <option key={i.key} value={i.key}>
                  {i.name}
                </option>
              ))}
            </select>
          </span>
          <span className="wt-lane-pill">{data?.categories?.find(c => c.id === head.lane)?.title ?? head.lane}</span>
        </div>
        {head.waitingOn && (head.status === 'waiting' || head.status === 'owner') && !head.proposed && (
          <p className="wt-summary wt-waiting">
            <KeyText text={head.waitingOn} onOpen={onOpen} />
          </p>
        )}
        {head.summary && !head.proposed && (
          <p className="wt-summary">
            <KeyText text={head.summary} onOpen={onOpen} />
          </p>
        )}
        {head.proposed && (
          <div className="wt-proposed">
            <p>
              <b>{partyLabel(head.proposed.by, t('wt.you'))}</b> {t('wt.proposed', { why: head.proposed.why })}
            </p>
            <button
              type="button"
              className="mini"
              disabled={!canEdit || busy}
              onClick={() => void write({ op: 'keep' })}
            >
              {t('wt.keepOpen')}
            </button>
            <button
              type="button"
              className="mini primary"
              disabled={!canEdit || busy}
              onClick={() => void write({ op: 'confirm' })}
            >
              {t('wt.confirm')}
            </button>
          </div>
        )}
        {view.children.length > 0 && (
          <div className="wt-subs">
            {view.children.map(k => (
              <MiniRow key={k.id} row={k} onOpen={onOpen} inParent />
            ))}
          </div>
        )}
      </header>
      <div className="wt-scroll" ref={scroll}>
        {feed.length === 0 && (
          <p className="hint wt-empty">
            <b>{t('wt.noEntries')}</b>
            {t('wt.noEntriesHint')}
          </p>
        )}
        {feed.map((item, i) => {
          if (item.kind === 'day')
            return (
              <div key={`day:${item.at}`} className="team-day">
                <span>
                  {new Date(item.at).toLocaleDateString(t.lang, { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
              </div>
            )
          const e = item.entry
          if (item.kind === 'status')
            return (
              <div key={`s:${e.id}`} className="wt-notice" data-line={e.id}>
                <span className="wt-notice-mark" style={{ '--c': statusColor(item.to) }} aria-hidden="true" />
                <span className="wt-notice-text">
                  <b>{partyLabel(e.author, t('wt.you'))}</b>{' '}
                  {t(`wt.did.${item.did}`, { status: statusWord(item.to, t) })}
                  {e.set?.summary ? ': ' : ''}
                  {e.set?.summary && <KeyText text={e.set.summary} onOpen={onOpen} />}
                </span>
                <time className="when" dateTime={iso(e.at)}>
                  {new Date(e.at).toLocaleTimeString(t.lang, { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
            )
          if (item.kind === 'ask')
            return (
              <div key={`a:${e.id}`} className={classNames('wt-asked', item.open && 'open')} data-line={e.id}>
                <b>{t('wt.asks', { who: partyLabel(e.author, t('wt.you')) })}</b>
                <p>
                  <KeyText text={e.text} onOpen={onOpen} />
                </p>
                {item.open && <span className="wt-asked-hint">{t('wt.answerHint')}</span>}
              </div>
            )
          const prev = feed[i - 1]
          const next = feed[i + 1]
          const same = (x: typeof prev) =>
            x?.kind === 'message' && JSON.stringify(x.entry.author) === JSON.stringify(e.author)
          return (
            <TeamMessage
              key={e.id}
              line={lineOf(e)}
              first={!same(prev)}
              last={!same(next)}
              named={false}
              quote={e.replyTo ? quote(e.replyTo) : null}
              onQuote={jump}
              {...(canEdit && { onReply: (id: string) => setReply(id) })}
              {...(!isOwnerParty(e.author) && { mark: <Mark entry={e} /> })}
              extra={<Files entry={e} />}
            />
          )
        })}
      </div>
      <div
        className="wt-foot"
        onPaste={e => {
          const given = [...(e.clipboardData?.files ?? [])]
          if (given.length && !asking) {
            e.preventDefault()
            files.add(head.key, given)
          }
        }}
      >
        <TeamComposer
          value={draft}
          placeholder={asking ? t('wt.answer') : t('wt.note')}
          disabled={!canEdit || busy}
          canSend={!!draft.trim() || attached.some(f => f.status === 'done')}
          onChange={setDraft}
          onSend={send}
          reply={reply ? quote(reply) : null}
          onCancelReply={() => setReply(null)}
          sendTitle={asking ? t('wt.answerSend') : t('wt.noteSend')}
          {...(attached.length > 0 && {
            attachments: (
              <Attachments id="wt-attachments" list={attached} onRemove={id => files.remove(head.key, id)} />
            ),
          })}
          {...(!asking && {
            actions: <AttachButton disabled={!canEdit || busy} onFiles={given => files.add(head.key, given)} />,
          })}
        />
      </div>
    </div>
  )
}
