// The small parts of threads on the page (#392, docs/design/threads 10): a status dot, the chip
// that names who holds a thread and opens that session, a known key in text as a link, the chips
// on a card and the fold in the session sheet's head. Each draws nothing while threads are off.
import { type ReactNode, useState } from 'react'
import type { Party } from '../../../../src/core/work-threads.ts'
import { useThreadsContext } from '../../hooks/useThreads.tsx'
import { useT } from '../../i18n/I18nProvider.tsx'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import {
  chipsOf,
  keyParts,
  partyLabel,
  sessionThreads,
  statusColor,
  type ThreadRow,
  type ThreadStatus,
} from '../../models/work-threads.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { ChevronGlyph } from '../icons.tsx'

export function StatusDot({ status }: { status: ThreadStatus }) {
  return (
    <span
      className={classNames('wt-dot', (status === 'next' || status === 'dropped') && 'idle')}
      style={{ '--c': statusColor(status) }}
      aria-hidden="true"
    />
  )
}

/** The status's word, as the panel says it. */
export const statusWord = (s: ThreadStatus, t: ReturnType<typeof useT>): string => t(`wt.status.${s}`)

/**
 * Who holds or wrote a thread (8): a session on this board opens its sheet, and its dot is its
 * card's column colour; a session the board no longer has, the owner and a peer are plain text.
 * `plain`: drawn inside a button (a list row), so not a button of its own.
 */
export function WhoChip({ party, plain = false }: { party: Party | null; plain?: boolean }) {
  const t = useT()
  const { data, dispatch } = useBoardContext()
  if (!party) return <span className="wt-who none">{t('wt.nobody')}</span>
  if (party.kind === 'owner') return <span className="wt-who">{t('wt.you')}</span>
  if (party.kind === 'peer')
    return (
      <span className="wt-who peer" title={t('wt.peerHint')}>
        {partyLabel(party, '')}
      </span>
    )
  const item = data?.items.find(i => i.key === party.key)
  const name = item?.name || party.name || party.key.slice(0, 8)
  const dot = item && <span className="wt-dot" style={{ '--c': COLUMN_COLORS[item.column] }} aria-hidden="true" />
  if (plain || !item)
    return (
      <span className={classNames('wt-who', !item && 'gone')} title={item ? undefined : t('wt.goneSession')}>
        {dot}
        {name}
      </span>
    )
  return (
    <button
      type="button"
      className="wt-who"
      data-session={party.key}
      title={t('wt.openSession')}
      onClick={e => {
        e.stopPropagation()
        dispatch({ type: 'open', key: party.key })
      }}
    >
      {dot}
      {name}
    </button>
  )
}

/** A thread's key as a link: opens it in the panel. */
export function KeyLink({ k, onOpen }: { k: string; onOpen?: (key: string) => void }) {
  const threads = useThreadsContext()
  const t = useT()
  return (
    <a
      className="wt-keylink"
      href={`#thread=${encodeURIComponent(k)}`}
      title={t('wt.openThread')}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        if (onOpen) onOpen(k)
        else threads?.open(k)
      }}
      // Inside a card: the card's own press (its sheet, a drag) does not start here.
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      {k}
    </a>
  )
}

/** Plain text with the known thread keys in it as links; text as it is while threads are off. */
export function KeyText({ text, onOpen }: { text: string; onOpen?: (key: string) => void }): ReactNode {
  const threads = useThreadsContext()
  if (!threads?.known.size) return text
  let at = 0
  return keyParts(text, threads.known).map(p => {
    const from = at
    at += typeof p === 'string' ? p.length : p.key.length
    return typeof p === 'string' ? p : <KeyLink key={from} k={p.key} {...(onOpen && { onOpen })} />
  })
}

/**
 * A card's threads (10.1): its session's open threads as chips, a status dot and the key, two at
 * most, then "+3". Nothing at all for a card whose session has none, or while threads are off.
 */
export function CardThreadChips({ session }: { session: string }) {
  const threads = useThreadsContext()
  const t = useT()
  if (!threads) return null
  const { shown, more } = chipsOf(threads.rows, session)
  if (!shown.length) return null
  return (
    <div className="wt-chips">
      {shown.map(r => (
        <button
          key={r.id}
          type="button"
          className="wt-chip"
          title={`${r.title} · ${statusWord(r.status, t)}`}
          onClick={e => {
            e.stopPropagation()
            threads.open(r.key)
          }}
          onPointerDown={e => e.stopPropagation()}
          onPointerUp={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <StatusDot status={r.status} />
          {r.key}
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          className="wt-chip more"
          title={t('wt.moreHint', { n: more })}
          onClick={e => {
            e.stopPropagation()
            threads.open(null)
          }}
          onPointerDown={e => e.stopPropagation()}
          onPointerUp={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          +{more}
        </button>
      )}
    </div>
  )
}

/** One row of a short list of threads (the sheet's fold, a parent's sub-threads): the row opens it. */
export function MiniRow({
  row,
  onOpen,
  inParent = false,
}: {
  row: ThreadRow
  onOpen(key: string): void
  inParent?: boolean
}) {
  const t = useT()
  const last = row.proposed ? t('wt.saysDone', { why: row.proposed.why }) : row.waitingOn || row.summary
  return (
    <button
      type="button"
      className={classNames('wt-row', 'sub', !inParent && 'fold', row.status === 'done' && 'done')}
      onClick={() => onOpen(row.key)}
    >
      <StatusDot status={row.status} />
      <span className="wt-row-main">
        <span className="wt-row-top">
          <code className="wt-key">{row.key}</code>
          <span className="wt-row-title">{row.title}</span>
        </span>
        {last && (
          <span className="wt-row-bottom">
            <span className="wt-row-last">{last}</span>
          </span>
        )}
      </span>
    </button>
  )
}

/** The session sheet's fold (10.4): the session's threads as rows with their status; a row opens it. */
export function SheetThreads({ session }: { session: string }) {
  const threads = useThreadsContext()
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!threads) return null
  const rows = sessionThreads(threads.rows, session)
  if (!rows.length) return null
  const live = rows.filter(r => r.status !== 'done' && r.status !== 'dropped').length
  return (
    <div className="wt-fold-sheet">
      <button
        type="button"
        className="wt-fold-head"
        aria-expanded={open}
        aria-controls="sheet-threads"
        onClick={() => setOpen(!open)}
      >
        <span className="wt-fold-label">{t('wt.title')}</span>
        <span className="wt-fold-text">{t('wt.foldText', { open: live, all: rows.length })}</span>
        <ChevronGlyph />
      </button>
      <div className="wt-fold-rows" id="sheet-threads" hidden={!open}>
        {rows.slice(0, 8).map(r => (
          <MiniRow key={r.id} row={r} onOpen={key => threads.open(key)} />
        ))}
        {rows.length > 8 && (
          <button type="button" className="wt-fold-more" onClick={() => threads.open(null)}>
            {t('wt.andMore', { n: rows.length - 8 })}
          </button>
        )}
      </div>
    </div>
  )
}
