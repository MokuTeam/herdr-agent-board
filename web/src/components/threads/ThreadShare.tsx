// A thread's sharing in its head (#394, docs/design/threads 11.2, 11.6): who a shared thread goes
// to, Stop sharing and Send history for one this board shared; an agent's request to share with
// Share and Decline; a teammate's offer with Take and Decline; and the owner's Share picker (a
// teammate, the team, a channel this board started, with its history or not). What goes out as the
// owner waits for the passkey when that gate is on (the caller's `act` posts through ownerPost).
import { type FormEvent, useEffect, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { TeamView, ThreadView as TopicView } from '../../models/team.ts'
import {
  nameIn,
  requestTarget,
  type ShareState,
  sharedBy,
  sharedWith,
  shareStateOf,
  shareTargets,
} from '../../models/work-share.ts'
import { partyLabel, type ThreadRow } from '../../models/work-threads.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

export interface ThreadShareProps {
  head: ThreadRow
  busy: boolean
  /** The owner's write; whether it went. */
  act(body: Record<string, unknown>): Promise<boolean>
  /** The owner pressed Share on a local thread: the picker is open. */
  picking: boolean
  onPicking(open: boolean): void
  /** The Team view and its topics, read by the pane while the thread is shared or Share is open. */
  team: { view: TeamView | null; topics: readonly TopicView[] }
}

/** Whether Team is on for this page (the payload carries its revision) and the owner may write. */
export function useShareable(): { teamOn: boolean; canEdit: boolean } {
  const { data, canEdit } = useBoardContext()
  return { teamOn: typeof data?.teamRev === 'number', canEdit }
}

/** The Share pill in a local thread's head: opens the picker. */
export function ShareButton({ head, busy, onPicking }: Pick<ThreadShareProps, 'head' | 'busy' | 'onPicking'>) {
  const t = useT()
  const { teamOn, canEdit } = useShareable()
  if (!teamOn || !canEdit || shareStateOf(head).kind !== 'local' || head.parentKey) return null
  return (
    <button
      type="button"
      className="wt-share-pill"
      disabled={busy}
      title={t('wt.share.hint')}
      onClick={() => onPicking(true)}
    >
      <ShareGlyph />
      {t('wt.share.button')}
    </button>
  )
}

function ShareGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="8" r="1.9" />
      <circle cx="12" cy="4" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <path d="M5.7 7.1l4.6-2.2M5.7 8.9l4.6 2.2" />
    </svg>
  )
}

export function ThreadShare({ head, busy, act, picking, onPicking, team }: ThreadShareProps) {
  const t = useT()
  const { teamOn, canEdit } = useShareable()
  const state: ShareState = shareStateOf(head)
  const { view, topics } = team
  const roster = view?.roster ?? []
  const me = view?.me.peer ?? null
  const targets = shareTargets(view, topics, t)
  const [to, setTo] = useState('')
  const [history, setHistory] = useState(false)
  // Another thread, or the picker closed: it starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another thread or another opening is when to start over
  useEffect(() => {
    setTo('')
    setHistory(false)
  }, [head.id, picking])
  const files = view?.files !== undefined

  if (state.kind === 'shared') {
    const s = state.scope
    const who = sharedWith(s, roster, me, t)
    const offerBy = s.offer ? nameIn(roster, s.offer.by, t) : ''
    return (
      <>
        <div className="wt-share" data-share="shared">
          <ShareGlyph />
          <span className="wt-share-text">
            {state.mine
              ? t('wt.share.with', { who })
              : s.kind === 'peer'
                ? t('wt.share.byPeer', { by: sharedBy(s, roster, t) })
                : t('wt.share.from', { by: sharedBy(s, roster, t), who })}
          </span>
          {canEdit && files && (
            <button
              type="button"
              className="mini"
              disabled={busy}
              title={t('wt.share.historyHint')}
              onClick={() => void act({ op: 'history' })}
            >
              {t('wt.share.sendHistory')}
            </button>
          )}
          {canEdit && state.mine && (
            <button type="button" className="mini" disabled={busy} onClick={() => void act({ op: 'unshare' })}>
              {t('wt.share.stop')}
            </button>
          )}
        </div>
        {state.offer && (
          <div className="wt-offer" data-share="offer">
            <p>{t('wt.offer.text', { who: offerBy })}</p>
            {canEdit && (
              <>
                <button type="button" className="mini" disabled={busy} onClick={() => void act({ op: 'decline' })}>
                  {t('wt.offer.decline')}
                </button>
                <button type="button" className="mini primary" disabled={busy} onClick={() => void act({ op: 'take' })}>
                  {t('wt.offer.take')}
                </button>
              </>
            )}
          </div>
        )}
      </>
    )
  }
  if (state.kind === 'ended')
    return (
      <div className="wt-share ended" data-share="ended">
        <ShareGlyph />
        <span className="wt-share-text">{t('wt.share.ended')}</span>
      </div>
    )
  if (state.kind === 'request') {
    const target = requestTarget(state.to, targets)
    const who = partyLabel(state.by, t('wt.you'))
    return (
      <div className="wt-request" data-share="request">
        <p>
          {t(state.history ? 'wt.share.requestHistory' : 'wt.share.request', {
            who,
            to: target?.label ?? state.to,
          })}
        </p>
        {canEdit && teamOn && (
          <>
            <button type="button" className="mini" disabled={busy} onClick={() => void act({ op: 'decline-share' })}>
              {t('wt.share.decline')}
            </button>
            <button
              type="button"
              className="mini primary"
              disabled={busy}
              onClick={() => void act({ op: 'share', to: target?.to ?? state.to, history: state.history })}
            >
              {t('wt.share.go')}
            </button>
          </>
        )}
      </div>
    )
  }
  if (!picking || !teamOn || !canEdit) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!to || busy) return
    void act({ op: 'share', to, history: history && files }).then(ok => {
      if (ok) onPicking(false)
    })
  }
  return (
    <form className="wt-share-pick" data-share="pick" onSubmit={submit}>
      {view && !targets.length ? (
        <p className="hint">{t('wt.share.none')}</p>
      ) : (
        <label className="wt-share-to">
          <span>{t('wt.share.to')}</span>
          <select value={to} disabled={busy || !view} onChange={e => setTo(e.target.value)}>
            <option value="">{view ? t('wt.share.pick') : t('wt.share.reading')}</option>
            {targets.map(x => (
              <option key={x.to} value={x.to}>
                {x.old ? t('wt.share.old', { name: x.label }) : x.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="wt-share-history" title={files ? t('wt.share.historyHint') : t('wt.share.noFiles')}>
        <input
          type="checkbox"
          checked={history && files}
          disabled={busy || !files}
          onChange={e => setHistory(e.target.checked)}
        />
        <span>{t('wt.share.history')}</span>
      </label>
      <span className="wt-share-note">{t('wt.share.note')}</span>
      <button type="button" className="mini" onClick={() => onPicking(false)}>
        {t('wt.share.cancel')}
      </button>
      <button type="submit" className="mini primary" disabled={!to || busy}>
        {t('wt.share.go')}
      </button>
    </form>
  )
}
