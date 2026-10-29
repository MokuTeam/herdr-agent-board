// "Profiles" and "Where the projects go" in the sync's preview (ProfileSync.tsx). Profiles: each
// of the source's profiles folded, its folder on both sides, there or to be made, and its projects,
// each where it lands and how, with the same choices as below (models/sync-profiles.ts); its folds
// open by themselves only for two profiles or fewer. Where the projects go: each path rule with the
// projects it places (its folders picked again, or removed), the rules suggested for the projects
// without a place (one click to use one, its folders picked first if need be), a new rule from two
// folders picked, then the projects by git remote, at the same path, chosen for themselves, left
// out and without a place; each project's own folder picked, or left out, or put back. A target
// folder not there yet is said, with what that means. Every folder is picked with FolderChooser:
// this computer's from POST /api/fs/dirs, the server's by the sync (`sync-dirs`, `sync-mkdir`).
import { useState } from 'react'
import type { Preview } from '../../../../src/core/profile-sync/plan.ts'
import {
  type PathRule,
  type Placed,
  type PlaceGroup,
  type PlaceKind,
  placeGroups,
} from '../../../../src/core/profile-sync/rules.ts'
import { launchApi } from '../../api/launch.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type Listing, pcListing, type Side, serverListing } from '../../models/folder-chooser.ts'
import { PROFILES_OPEN, type ProfileProject, profileFolds } from '../../models/sync-profiles.ts'
import { FolderChooser } from './FolderChooser.tsx'

export interface SyncPlacesProps {
  p: Preview
  send: AccessSend
  passwords: { password?: string; sudoPassword?: string }
  enabled: boolean
  /** Why a change was refused, for the panel's line. */
  onSaid(text: string): void
}

/** What a folder is picked for: a rule's side (a kept one, a suggestion, the new one) or a project's own path (asked in its profile or below). */
type Picking =
  | { kind: 'rule'; index: number; side: Side }
  | { kind: 'suggested'; index: number; side: Side }
  | { kind: 'new'; side: Side }
  | { kind: 'project'; at: 'profiles' | 'places'; profile: string; folder: string; side: Side }

const keyOf = (x: Picking): string =>
  x.kind === 'project' ? `project:${x.at}:${x.profile}/${x.folder}` : x.kind === 'new' ? 'new' : `${x.kind}:${x.index}`

/** Where the picker opens for a project: its target's parent folder. */
const startOf = (x: Placed): string => (x.to === null ? '' : x.to.replace(/[\\/][^\\/]*$/, '') || '')

export function SyncPlaces({ p, send, passwords, enabled, onSaid }: SyncPlacesProps) {
  const t = useT()
  const [picking, setPicking] = useState<Picking | null>(null)
  /** The suggestions as the owner changed their folders, by their place. */
  const [edited, setEdited] = useState<Record<number, PathRule>>({})
  const [draft, setDraft] = useState<{ pc: string; server: string } | null>(null)
  const groups = placeGroups(p)
  const folds = profileFolds(p)
  const target: Side = p.direction === 'up' ? 'server' : 'pc'
  const notThere = groups.some(g => g.list.some(x => x.there === false))

  const answer = (r: Record<string, unknown> | null): boolean => {
    const ok = r?.ok === true
    onSaid(ok ? '' : typeof r?.error === 'string' ? r.error : '')
    return ok
  }
  const saveRules = async (rules: PathRule[]): Promise<boolean> =>
    answer(await send('sync-rules', { rules, ...passwords }))
  const place = async (x: { profile: string; folder: string }, path: string | null): Promise<void> => {
    answer(await send('sync-pair', { profile: x.profile, folder: x.folder, path, ...passwords }))
  }

  async function list(side: Side, path: string): Promise<Listing | string> {
    if (side === 'pc') return pcListing(await launchApi.dirs(path, false)) ?? t('sync.err.failed')
    const r = await send('sync-dirs', { path, ...passwords })
    return serverListing(r) ?? (typeof r?.error === 'string' ? r.error : t('sync.err.failed'))
  }
  async function make(path: string, name: string): Promise<Listing | string> {
    const r = await send('sync-mkdir', { path, name, ...passwords })
    return serverListing(r) ?? (typeof r?.error === 'string' ? r.error : t('sync.err.failed'))
  }

  async function chosen(x: Picking, path: string): Promise<void> {
    setPicking(null)
    if (x.kind === 'project') return place(x, path)
    const field = x.side === 'pc' ? 'pc' : 'server'
    if (x.kind === 'rule') await saveRules(p.rules.map((r, i) => (i === x.index ? { ...r, [field]: path } : r)))
    else if (x.kind === 'suggested') {
      const r = edited[x.index] ?? p.suggested[x.index]?.rule
      if (r) setEdited({ ...edited, [x.index]: { ...r, [field]: path } })
    } else setDraft({ ...(draft ?? { pc: '', server: '' }), [field]: path })
  }

  /** The picker, where `x` was asked for. */
  const chooser = (x: Picking, start: string) =>
    picking && keyOf(picking) === keyOf(x) && picking.side === x.side ? (
      <FolderChooser
        side={x.side}
        start={start}
        list={path => list(x.side, path)}
        {...(x.side === 'server' && { make })}
        onChoose={path => void chosen(x, path)}
        onCancel={() => setPicking(null)}
      />
    ) : null

  /** "This computer…" and "The server…" for a rule's folders. */
  const sides = (x: (side: Side) => Picking) => (
    <>
      <button type="button" className="button" disabled={!enabled} onClick={() => setPicking(x('pc'))}>
        {t('sync.panel.choosePc')}
      </button>
      <button type="button" className="button" disabled={!enabled} onClick={() => setPicking(x('server'))}>
        {t('sync.panel.chooseServer')}
      </button>
    </>
  )

  /** A project's choices, as it is placed: its own folder; back to the rules; left out, or put back. */
  const actions = (kind: PlaceKind, x: Placed, pick: Picking) => (
    <>
      <button type="button" className="button" disabled={!enabled} onClick={() => setPicking(pick)}>
        {t('sync.panel.choose')}
      </button>
      {kind === 'chosen' && (
        <button type="button" className="button" disabled={!enabled} onClick={() => void place(x, '')}>
          {t('sync.panel.asRules')}
        </button>
      )}
      {kind === 'left' ? (
        <button type="button" className="button" disabled={!enabled} onClick={() => void place(x, '')}>
          {t('sync.panel.putBack')}
        </button>
      ) : (
        <button type="button" className="button" disabled={!enabled} onClick={() => void place(x, null)}>
          {t('sync.panel.leaveOut')}
        </button>
      )}
    </>
  )

  const notThereMark = (x: Placed) =>
    x.there === false && <span className="sync-not-there"> · {t('sync.panel.notThere')}</span>

  const row = (g: PlaceGroup, x: Placed) => {
    const pick: Picking = { kind: 'project', at: 'places', profile: x.profile, folder: x.folder, side: target }
    return (
      <li key={`${x.profile}/${x.folder}`}>
        <div className="sync-place">
          <span className="sync-place-path">
            {x.profile}: {x.to === null ? (x.from ?? x.folder) : `${x.from ?? x.folder} → ${x.to}`}
            {x.why !== undefined && x.why !== 'left' && ` (${t(`sync.panel.why.${x.why}`)})`}
            {notThereMark(x)}
          </span>
          {actions(g.kind, x, pick)}
        </div>
        {chooser(pick, startOf(x))}
      </li>
    )
  }

  /** A project in its profile: from → to (or no place yet), how it is placed. */
  const profileRow = (x: ProfileProject) => {
    const pick: Picking = { kind: 'project', at: 'profiles', profile: x.profile, folder: x.folder, side: target }
    const how =
      x.kind === 'none' && x.why !== undefined ? t(`sync.panel.why.${x.why}`) : t(`sync.panel.placed.${x.kind}`)
    return (
      <li key={`${x.profile}/${x.folder}`}>
        <div className="sync-place">
          <span className="sync-place-path">
            {x.from ?? x.folder} → {x.to ?? t('sync.panel.noPlace')} ({how}){notThereMark(x)}
          </span>
          {actions(x.kind, x, pick)}
        </div>
        {chooser(pick, startOf(x))}
      </li>
    )
  }

  const titleOf = (g: PlaceGroup): string =>
    g.kind === 'rule'
      ? t('sync.panel.rule', { pc: g.rule?.pc ?? '', server: g.rule?.server ?? '' })
      : t(
          {
            remote: 'sync.panel.byRemote',
            same: 'sync.panel.samePath',
            chosen: 'sync.panel.chosen',
            left: 'sync.panel.leftOut',
            none: 'sync.panel.noPair',
          }[g.kind],
        )

  const profiles = folds.length > 0 && (
    <details className="sync-group sync-profiles" open>
      <summary>
        {t('sync.panel.profiles')} · {folds.length}
      </summary>
      <p className="access-note">{t('sync.panel.profilesNote')}</p>
      {folds.map(f => (
        <details className="sync-profile" key={f.name} open={folds.length <= PROFILES_OPEN}>
          <summary>
            {f.name} · {f.from} → {f.to} · {t(f.create ? 'sync.panel.profileMade' : 'sync.panel.profileThere')} ·{' '}
            {t('sync.panel.projects', { n: f.projects.length })}
          </summary>
          {f.projects.length === 0 ? (
            <p className="access-note">{t('sync.panel.profileEmpty')}</p>
          ) : (
            <ul className="sync-list">{f.projects.map(profileRow)}</ul>
          )}
        </details>
      ))}
    </details>
  )

  // no project on either side: nothing to place
  if (p.pairs.length === 0 && p.unpaired.length === 0 && p.rules.length === 0) return profiles || null
  return (
    <>
      {profiles}
      <details className="sync-group sync-places" open>
        <summary>{t('sync.panel.places')}</summary>
        <p className="access-note">{t('sync.panel.placesNote')}</p>
        {notThere && <p className="access-note">{t('sync.panel.notThereNote')}</p>}
        {p.suggested.map((s, index) => {
          const r = edited[index] ?? s.rule
          return (
            <div className="sync-places-group" key={`suggested:${s.rule.pc}`}>
              <div className="sync-places-head">
                <span>
                  {t('sync.panel.suggested', {
                    pc: r.pc,
                    server: r.server,
                    projects: t('sync.panel.projects', { n: s.projects }),
                  })}
                </span>
                <button
                  type="button"
                  className="button primary"
                  disabled={!enabled}
                  onClick={() => void saveRules([...p.rules, r])}
                >
                  {t('sync.panel.accept')}
                </button>
                {sides(side => ({ kind: 'suggested', index, side }))}
              </div>
              {chooser({ kind: 'suggested', index, side: 'pc' }, r.pc)}
              {chooser({ kind: 'suggested', index, side: 'server' }, r.server)}
            </div>
          )
        })}
        {groups.map(g => {
          const index = g.index ?? -1
          const rule = g.rule
          return (
            <div className="sync-places-group" key={g.kind === 'rule' ? `rule:${index}` : g.kind}>
              <div className="sync-places-head">
                <span>
                  {titleOf(g)} · {g.list.length}
                </span>
                {rule && (
                  <>
                    {sides(side => ({ kind: 'rule', index, side }))}
                    <button
                      type="button"
                      className="button"
                      disabled={!enabled}
                      onClick={() => void saveRules(p.rules.filter((_, i) => i !== index))}
                    >
                      {t('sync.panel.removeRule')}
                    </button>
                  </>
                )}
              </div>
              {rule && chooser({ kind: 'rule', index, side: 'pc' }, rule.pc)}
              {rule && chooser({ kind: 'rule', index, side: 'server' }, rule.server)}
              {g.kind === 'none' && <p className="access-note">{t('sync.panel.noPairNote')}</p>}
              {g.kind === 'rule' && g.list.length === 0 && <p className="access-note">{t('sync.panel.ruleEmpty')}</p>}
              {g.list.length > 0 && <ul className="sync-list">{g.list.map(x => row(g, x))}</ul>}
            </div>
          )
        })}
        {draft === null ? (
          <div className="access-actions">
            <button
              type="button"
              className="button"
              disabled={!enabled}
              onClick={() => setDraft({ pc: '', server: '' })}
            >
              {t('sync.panel.addRule')}
            </button>
          </div>
        ) : (
          <div className="sync-places-group">
            <div className="sync-places-head">
              <span>
                {draft.pc && draft.server
                  ? t('sync.panel.rule', { pc: draft.pc, server: draft.server })
                  : t('sync.panel.newRule')}
              </span>
              {sides(side => ({ kind: 'new', side }))}
              <button
                type="button"
                className="button primary"
                disabled={!enabled || !draft.pc || !draft.server}
                onClick={() =>
                  void saveRules([...p.rules, draft]).then(ok => {
                    if (ok) setDraft(null)
                  })
                }
              >
                {t('sync.panel.accept')}
              </button>
              <button type="button" className="button" onClick={() => setDraft(null)}>
                {t('sync.pick.cancel')}
              </button>
            </div>
            <p className="access-note">
              {t('sync.panel.pcFolder')}: {draft.pc || '—'} · {t('sync.panel.serverFolder')}: {draft.server || '—'}
            </p>
            {chooser({ kind: 'new', side: 'pc' }, draft.pc)}
            {chooser({ kind: 'new', side: 'server' }, draft.server)}
          </div>
        )}
      </details>
    </>
  )
}
