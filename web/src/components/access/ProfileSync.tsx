// "Sync profiles" in the Remote access panel, where the board installed on the server lives
// (services/profile-sync.ts): the direction, Preview, then the preview grouped and folded (added,
// changed, merged by key with each key it adds or changes, each group that changes how the target
// runs with a tick of its own, session history with its tick, conflicts with a choice each, the
// deletions with one tick and one more for each the target changed, what is held back, what a cut
// keeps from going, what can't go, the profiles with their projects, where the projects go:
// SyncPlaces.tsx), Apply, its progress and
// its end with what the target left as it was. Every
// choice is the preview's own: a new preview starts them all again unticked. The login is the
// server's sign-in above it: its password goes with each request (the panel's own state), never
// kept by the board. The board's side is the `sync-*` ops of POST /api/access.
import { type ReactNode, useState } from 'react'
import {
  byArea,
  type Change,
  DEFAULT_SYNC_HISTORY,
  type Direction,
  sizeOf,
  type Ticks,
} from '../../../../src/core/profile-sync/plan.ts'
import { RUN_GROUPS, type RunGroup } from '../../../../src/core/profile-sync/secrets.ts'
import type { SyncView } from '../../../../src/core/profile-sync/view.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { SyncPlaces } from './SyncPlaces.tsx'

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
function Group({ title, list, children }: { title: string; list: Row[]; children?: ReactNode }) {
  const t = useT()
  if (list.length === 0) return null
  const bytes = list.reduce((n, r) => n + (r.size ?? 0), 0)
  return (
    <details className="sync-group">
      <summary>
        {title} · {t('sync.panel.files', { n: list.length })}
        {bytes > 0 && ` · ${sizeOf(bytes)}`}
      </summary>
      {children}
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

/** The owner's choices on one preview: a new preview starts them again. */
interface Choice {
  id: string | null
  conflicts: Record<string, 'source' | 'target'>
  /** The deletions the target has not changed since: one tick. */
  deletions: boolean
  /** Each deletion the target changed since: a tick of its own. */
  each: Record<string, boolean>
  allow: Ticks
}

const fresh = (id: string | null): Choice => ({
  id,
  conflicts: {},
  deletions: false,
  each: {},
  allow: {
    ...(Object.fromEntries(RUN_GROUPS.map(g => [g, false])) as Record<RunGroup, boolean>),
    history: DEFAULT_SYNC_HISTORY,
  },
})

export function ProfileSync({ sync, send, passwords, enabled }: ProfileSyncProps) {
  const t = useT()
  const [direction, setDirection] = useState<Direction>('up')
  const [choice, setChoice] = useState<Choice>(() => fresh(null))
  const [said, setSaid] = useState('')
  const phase = sync?.phase ?? 'idle'
  const p = phase === 'preview' ? (sync?.preview ?? null) : null
  const busy = phase === 'looking' || phase === 'applying'
  // the choices made on this preview; none yet on a new one
  const c = p && choice.id === p.id ? choice : fresh(p?.id ?? null)
  const choose = (patch: Partial<Choice>): void => setChoice({ ...c, ...patch })

  async function look(): Promise<void> {
    setSaid('')
    setChoice(fresh(null))
    const r = await send('sync-look', { direction, ...passwords })
    if (r?.ok !== true) setSaid(typeof r?.error === 'string' ? r.error : '')
  }

  async function apply(): Promise<void> {
    if (!p) return
    setSaid('')
    const r = await send('sync-apply', {
      id: p.id,
      conflicts: c.conflicts,
      deletions: p.deletions.filter(d => (d.changedThere ? c.each[d.key] === true : c.deletions)).map(d => d.key),
      allow: c.allow,
      ...passwords,
    })
    if (r?.ok !== true) setSaid(typeof r?.error === 'string' ? r.error : '')
  }

  const items = p?.items ?? []
  /** Goes as ticked: session history, a hook's or the status line's script only with their tick. */
  const ticked = (x: { history: boolean; group?: RunGroup }): boolean =>
    (!x.history || c.allow.history) && (x.group === undefined || c.allow[x.group])
  const going = items.filter(ticked)
  const history = items.filter(i => i.history)
  const plain = items.filter(i => !i.history && i.group === undefined)
  const taken = (p?.conflicts ?? []).filter(x => c.conflicts[x.key] === 'source' && ticked(x))
  const sent = going.length + taken.length
  const deleting = (p?.deletions ?? []).some(d => ticked(d) && (d.changedThere ? c.each[d.key] === true : c.deletions))
  const changes = p?.changes ?? []
  const filesOf = (g: RunGroup) => items.filter(i => i.group === g)
  const keyLine = (x: Change): string => `${x.profile}: ${x.rel} · ${x.key} (${t(`sync.panel.how.${x.how}`)})`
  const underSessions = going.some(i => i.kind === 'merge')
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
                  files: t('sync.panel.files', { n: going.length }),
                  size: sizeOf(going.reduce((n, i) => n + i.size, 0)),
                  conflicts: p.conflicts.length,
                  deletions: p.deletions.length,
                })}
          </p>
          {underSessions && <p className="access-warn">{t(`sync.panel.idle.${p.direction}`)}</p>}
          <Group title={t('sync.panel.add')} list={plain.filter(i => i.kind === 'add')} />
          <Group title={t('sync.panel.change')} list={plain.filter(i => i.kind === 'change')} />
          <Group title={t('sync.panel.merge')} list={plain.filter(i => i.kind === 'merge')}>
            {changes.some(x => x.group === null) && (
              <ul className="sync-list">
                {changes
                  .filter(x => x.group === null)
                  .map(x => (
                    <li key={`${x.profile}:${x.rel}:${x.key}`}>{keyLine(x)}</li>
                  ))}
              </ul>
            )}
          </Group>
          {RUN_GROUPS.filter(g => changes.some(x => x.group === g) || filesOf(g).length > 0).map(g => (
            <details className="sync-group sync-run" open key={g}>
              <summary>
                {t(`sync.panel.group.${g}`)} · {changes.filter(x => x.group === g).length + filesOf(g).length}
              </summary>
              <p className="access-note">{t(`sync.panel.groupNote.${p.direction}`)}</p>
              <ul className="sync-list">
                {changes
                  .filter(x => x.group === g)
                  .map(x => (
                    <li key={`${x.profile}:${x.rel}:${x.key}`}>{keyLine(x)}</li>
                  ))}
                {filesOf(g).map(i => (
                  <li key={`${i.profile}:${i.to}`}>
                    {i.profile}: {i.to} ({t(`sync.panel.how.${i.kind === 'add' ? 'add' : 'change'}`)})
                  </li>
                ))}
              </ul>
              <label className="access-tick">
                <input
                  type="checkbox"
                  name={`sync-allow-${g}`}
                  checked={c.allow[g]}
                  disabled={!enabled}
                  onChange={() => choose({ allow: { ...c.allow, [g]: !c.allow[g] } })}
                />
                <span>{t(`sync.panel.groupTick.${p.direction}`)}</span>
              </label>
            </details>
          ))}
          {(history.length > 0 || p.conflicts.some(x => x.history) || p.deletions.some(d => d.history)) && (
            <Group title={t('sync.panel.history')} list={history}>
              <p className="access-note">{t('sync.panel.historyNote')}</p>
              <label className="access-tick">
                <input
                  type="checkbox"
                  name="sync-allow-history"
                  checked={c.allow.history}
                  disabled={!enabled}
                  onChange={() => choose({ allow: { ...c.allow, history: !c.allow.history } })}
                />
                <span>{t('sync.panel.historyTick')}</span>
              </label>
            </Group>
          )}
          {p.conflicts.length > 0 && (
            <details className="sync-group" open>
              <summary>
                {t('sync.panel.conflicts')} · {p.conflicts.length}
              </summary>
              <ul className="sync-list">
                {p.conflicts.map(x => (
                  <li className="sync-conflict" key={x.key}>
                    <span>
                      {x.profile}: {x.to} ({sizeOf(x.size)} / {x.thereSize === null ? '—' : sizeOf(x.thereSize)})
                      {x.caseOf !== undefined && ` (${t('sync.panel.caseOf', { name: x.caseOf })})`}
                    </span>
                    <select
                      aria-label={x.to}
                      value={c.conflicts[x.key] ?? 'target'}
                      disabled={!enabled}
                      onChange={e =>
                        choose({ conflicts: { ...c.conflicts, [x.key]: e.target.value as 'source' | 'target' } })
                      }
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
                    {d.changedThere && (
                      <label className="access-tick">
                        <input
                          type="checkbox"
                          name={`sync-delete-${d.key}`}
                          checked={c.each[d.key] === true}
                          disabled={!enabled}
                          onChange={() => choose({ each: { ...c.each, [d.key]: c.each[d.key] !== true } })}
                        />
                        <span>{t('sync.panel.deleteChanged')}</span>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
              {p.deletions.some(d => !d.changedThere) && (
                <label className="access-tick">
                  <input
                    type="checkbox"
                    name="sync-deletions"
                    checked={c.deletions}
                    disabled={!enabled}
                    onChange={() => choose({ deletions: !c.deletions })}
                  />
                  <span>{t('sync.panel.deleteTick')}</span>
                </label>
              )}
            </details>
          )}
          <Lines title={t('sync.panel.held')} lines={p.held.map(h => `${h.profile}: ${h.what}`)} />
          <Lines title={t('sync.panel.cut')} lines={p.cut.map(x => `${x.profile}: ${x.what}`)} />
          <Lines title={t('sync.panel.cantGo')} lines={p.cantGo.map(x => `${x.profile}: ${x.what}`)} />
          <SyncPlaces key={p.id} p={p} send={send} passwords={passwords} enabled={enabled} onSaid={setSaid} />
          <div className="access-actions">
            <button
              type="button"
              className="button primary"
              disabled={!enabled || (sent === 0 && !deleting && p.same.length === 0)}
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
          <Lines
            title={t('sync.panel.skipped')}
            lines={(result.skipped ?? []).map(s => `${s.profile}: ${s.rel} (${t(`sync.panel.skip.${s.why}`)})`)}
          />
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
