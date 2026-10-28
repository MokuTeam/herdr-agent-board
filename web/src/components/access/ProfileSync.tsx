// "Sync profiles" in the Remote access panel, where the board installed on the server lives
// (services/profile-sync.ts): the direction, Preview, then the preview grouped and folded (added,
// changed, merged by key, conflicts with a choice each, the deletions with one tick, what is held
// back, the paths rewritten, what can't go, the projects not paired with a path to give or leave
// out), Apply, its progress and its end. The login is the server's sign-in above it: its password
// goes with each request (the panel's own state), never kept by the board. The board's side is the
// `sync-*` ops of POST /api/access.
import { type KeyboardEvent, useState } from 'react'
import type { Unpaired } from '../../../../src/core/profile-sync/paths.ts'
import { byArea, type Direction, projectKey, sizeOf } from '../../../../src/core/profile-sync/plan.ts'
import type { SyncView } from '../../../../src/core/profile-sync/view.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'

export interface ProfileSyncProps {
  sync: SyncView | null
  send: AccessSend
  /** The server's sign-in's passwords as typed above (none when not typed). */
  passwords: { password?: string; sudoPassword?: string }
  /** The board may change things, and the server's sign-in is not busy with another run. */
  enabled: boolean
}

/** The most entries an area lists; the rest are counted. */
const LISTED = 200

type Row = { from: string; to: string; size?: number; thereSize?: number | null }

function Area({ area, list, bytes }: { area: string; list: Row[]; bytes: number }) {
  const t = useT()
  return (
    <details className="sync-area">
      <summary>
        {area} · {t('sync.panel.files', { n: list.length })}
        {bytes > 0 && ` · ${sizeOf(bytes)}`}
      </summary>
      <ul className="sync-list">
        {list.slice(0, LISTED).map(r => (
          <li key={`${r.from}>${r.to}`}>{r.from === r.to ? r.to : `${r.from} → ${r.to}`}</li>
        ))}
        {list.length > LISTED && <li>… {list.length - LISTED}</li>}
      </ul>
    </details>
  )
}

/** A kind of item, folded, its areas folded inside it. */
function Group({ title, list }: { title: string; list: Row[] }) {
  const t = useT()
  if (list.length === 0) return null
  const bytes = list.reduce((n, r) => n + (r.size ?? 0), 0)
  return (
    <details className="sync-group">
      <summary>
        {title} · {t('sync.panel.files', { n: list.length })}
        {bytes > 0 && ` · ${sizeOf(bytes)}`}
      </summary>
      {byArea(list).map(g => (
        <Area key={g.area} {...g} />
      ))}
    </details>
  )
}

/** Words, folded: what is held back, what can't go. */
function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <details className="sync-group">
      <summary>
        {title} · {lines.length}
      </summary>
      <ul className="sync-list">
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the same words may come twice, from two profiles
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  )
}

export function ProfileSync({ sync, send, passwords, enabled }: ProfileSyncProps) {
  const t = useT()
  const [direction, setDirection] = useState<Direction>('up')
  const [conflicts, setConflicts] = useState<Record<string, 'source' | 'target'>>({})
  const [deletions, setDeletions] = useState(false)
  const [said, setSaid] = useState('')
  const phase = sync?.phase ?? 'idle'
  const p = phase === 'preview' ? (sync?.preview ?? null) : null
  const busy = phase === 'looking' || phase === 'applying'

  async function look(): Promise<void> {
    setSaid('')
    setConflicts({})
    setDeletions(false)
    const r = await send('sync-look', { direction, ...passwords })
    if (r?.ok !== true) setSaid(typeof r?.error === 'string' ? r.error : '')
  }

  async function apply(): Promise<void> {
    if (!p) return
    setSaid('')
    const r = await send('sync-apply', {
      id: p.id,
      conflicts,
      deletions: deletions ? p.deletions.map(d => d.key) : [],
      ...passwords,
    })
    if (r?.ok !== true) setSaid(typeof r?.error === 'string' ? r.error : '')
  }

  async function pair(u: Unpaired, path: string | null): Promise<void> {
    const r = await send('sync-pair', { profile: u.profile, folder: u.folder, path })
    setSaid(r?.ok === true ? '' : typeof r?.error === 'string' ? r.error : '')
  }

  const pathKeyDown = (u: Unpaired) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void pair(u, e.currentTarget.value)
  }

  const items = p?.items ?? []
  const sent = items.length + Object.values(conflicts).filter(c => c === 'source').length
  const progress = sync?.progress ?? null
  const result = phase === 'done' ? (sync?.result ?? null) : null
  const created = result?.created ?? []

  return (
    <details className="access-sync" open={sync !== null}>
      <summary className="access-summary">{t('sync.panel.title')}</summary>
      <p className="access-note">{t('sync.panel.intro')}</p>
      <div className="access-actions" role="radiogroup" aria-label={t('sync.panel.title')}>
        {(['up', 'down'] as const).map(d => (
          <label className="access-tick" key={d}>
            <input
              type="radio"
              name="sync-direction"
              checked={direction === d}
              disabled={busy || !enabled}
              onChange={() => setDirection(d)}
            />
            <span>{t(`sync.panel.${d}`)}</span>
          </label>
        ))}
      </div>
      <div className="access-actions">
        <button type="button" className="button" disabled={busy || !enabled} onClick={() => void look()}>
          {phase === 'looking' ? t('sync.panel.looking') : t('sync.panel.look')}
        </button>
        {busy && (
          <button type="button" className="button" onClick={() => void send('sync-cancel')}>
            {t('sync.panel.cancel')}
          </button>
        )}
      </div>
      {said && <p className="access-why">{said}</p>}

      {p && (
        <div className="sync-preview">
          <p className="access-sub">
            {items.length + p.conflicts.length + p.deletions.length === 0
              ? t('sync.panel.nothing')
              : t('sync.panel.summary', {
                  files: t('sync.panel.files', { n: items.length }),
                  size: sizeOf(p.bytes),
                  conflicts: p.conflicts.length,
                  deletions: p.deletions.length,
                })}
          </p>
          {p.profiles
            .filter(x => x.create)
            .map(x => (
              <p className="access-note" key={x.name}>
                {t('sync.panel.create', { name: x.name, dir: x.dir })}
              </p>
            ))}
          <Group title={t('sync.panel.add')} list={items.filter(i => i.kind === 'add')} />
          <Group title={t('sync.panel.change')} list={items.filter(i => i.kind === 'change')} />
          <Group title={t('sync.panel.merge')} list={items.filter(i => i.kind === 'merge')} />
          {p.conflicts.length > 0 && (
            <details className="sync-group" open>
              <summary>
                {t('sync.panel.conflicts')} · {p.conflicts.length}
              </summary>
              <ul className="sync-list">
                {p.conflicts.map(c => (
                  <li className="sync-conflict" key={c.key}>
                    <span>
                      {c.profile}: {c.to} ({sizeOf(c.size)} / {c.thereSize === null ? '—' : sizeOf(c.thereSize)})
                    </span>
                    <select
                      aria-label={c.to}
                      value={conflicts[c.key] ?? 'target'}
                      disabled={!enabled}
                      onChange={e => setConflicts(s => ({ ...s, [c.key]: e.target.value as 'source' | 'target' }))}
                    >
                      <option value="target">{t('sync.panel.keepThere')}</option>
                      <option value="source">{t('sync.panel.takeHere')}</option>
                    </select>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {p.deletions.length > 0 && (
            <details className="sync-group" open>
              <summary>
                {t('sync.panel.deletions')} · {p.deletions.length}
              </summary>
              <ul className="sync-list">
                {p.deletions.map(d => (
                  <li key={d.key}>
                    {d.profile}: {d.to}
                    {d.changedThere && ` (${t('sync.panel.changedThere')})`}
                  </li>
                ))}
              </ul>
              <label className="access-tick">
                <input
                  type="checkbox"
                  name="sync-deletions"
                  checked={deletions}
                  disabled={!enabled}
                  onChange={() => setDeletions(v => !v)}
                />
                <span>{t('sync.panel.deleteTick')}</span>
              </label>
            </details>
          )}
          <Lines title={t('sync.panel.held')} lines={p.held.map(h => `${h.profile}: ${h.what}`)} />
          <Lines
            title={t('sync.panel.rewritten')}
            lines={p.pairs.flatMap(x => [
              `${x.profile}: ${t('sync.panel.pair', { from: x.from || x.folder, to: x.to })}`,
              ...(x.folder !== x.toFolder ? [`  ${t('sync.panel.renamed', { from: x.folder, to: x.toFolder })}`] : []),
            ])}
          />
          <Lines title={t('sync.panel.cantGo')} lines={p.cantGo.map(c => `${c.profile}: ${c.what}`)} />
          {p.unpaired.length > 0 && (
            <details className="sync-group">
              <summary>
                {t('sync.panel.unpaired')} · {p.unpaired.length}
              </summary>
              <p className="access-note">{t('sync.panel.unpairedNote')}</p>
              <ul className="sync-list">
                {p.unpaired.map(u => (
                  <li className="sync-unpaired" key={projectKey(u)}>
                    <span>
                      {u.profile}: {u.path ?? u.folder} ({t(`sync.panel.why.${u.why}`)},{' '}
                      {t('sync.panel.files', { n: u.files })}, {sizeOf(u.bytes)})
                    </span>
                    <input
                      type="text"
                      name={`sync-path-${projectKey(u)}`}
                      aria-label={t('sync.panel.pathPlaceholder')}
                      placeholder={t('sync.panel.pathPlaceholder')}
                      disabled={!enabled}
                      onKeyDown={pathKeyDown(u)}
                      onBlur={e => {
                        if (e.currentTarget.value.trim() !== '') void pair(u, e.currentTarget.value)
                      }}
                    />
                    {u.why !== 'left' && (
                      <button type="button" className="button" disabled={!enabled} onClick={() => void pair(u, null)}>
                        {t('sync.panel.leaveOut')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="access-actions">
            <button
              type="button"
              className="button primary"
              disabled={!enabled || (sent === 0 && !(deletions && p.deletions.length > 0) && p.same.length === 0)}
              onClick={() => void apply()}
            >
              {t('sync.panel.apply')}
            </button>
            <button type="button" className="button" onClick={() => void send('sync-forget')}>
              {t('sync.panel.close')}
            </button>
          </div>
        </div>
      )}

      {phase === 'applying' && progress && (
        <p className="access-sub">
          {progress.step === 'record'
            ? t('sync.panel.recording')
            : t('sync.panel.sending', {
                files: progress.files,
                total: progress.filesTotal,
                size: sizeOf(progress.bytes),
                sizeTotal: sizeOf(progress.bytesTotal),
              })}
        </p>
      )}
      {result && (
        <div className="sync-result">
          <p className="access-result">
            {t('sync.panel.done', {
              files: result.files,
              size: sizeOf(result.bytes),
              deleted: result.deleted,
              kept: result.kept,
            })}
          </p>
          {result.gone > 0 && <p className="access-note">{t('sync.panel.gone', { n: result.gone })}</p>}
          {created.length > 0 && sync?.direction === 'up' && (
            <p className="access-warn">
              {t('sync.panel.created', { names: created.join(', ') })}{' '}
              {result.install === false ? t('sync.panel.notInstalled') : t('sync.panel.installed')}
            </p>
          )}
          {created.length > 0 && sync?.direction === 'down' && (
            <p className="access-warn">{t('sync.panel.createdHere', { names: created.join(', ') })}</p>
          )}
        </div>
      )}
      {phase === 'failed' && sync?.error && !said && (
        <p className="access-warn">{t('sync.panel.failed', { why: sync.error })}</p>
      )}
    </details>
  )
}
