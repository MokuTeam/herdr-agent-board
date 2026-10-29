// Settings → Time tracking… (#237), on the local board only, as Settings → Backup… is: time on and
// off, the zone days are counted in; the clients in the lanes' order, each a row with its lane's
// color, a line of what it has and its switch (off: no new entries, its own stay), opened in place
// to its projects (each with its entries, billable or not, Rename and Retire; a new one added;
// the retired ones under them, each to bring back), whether it is billed, and where its time is
// entered; the lanes without time, each a Take time away; a new lane that takes time in one step.
// Every change goes to POST /api/time-settings at once and the view comes back with its answer:
// nothing is held on the page. What the board refuses is said under the part it is about. A
// rename says first how many entries move with it, and its toast says how many did. Billing rules
// stay in config.json: a client that has some says so.
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import type { BoardCategory, Swatch } from '../../../../src/core/payload.ts'
import { systemsOfProject } from '../../../../src/core/time.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { draftColor } from '../../models/categories.ts'
import {
  clientLine,
  clientOrder,
  isTimeSettingsView,
  lanesWithout,
  type TimeClientView,
  type TimeSettingsView,
  zonesOf,
} from '../../models/time-settings.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { CategoryDraft } from '../categories/CategoryDraft.tsx'
import { classNames } from '../class-names.ts'
import { ArchiveGlyph, ChevIcon, PlusIcon, WriteGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface TimeSettingsPanelProps {
  open: boolean
  onClose(): void
}

/** One change: its body; true when the board took it. `part` is where a refusal is said. */
export type TimeSettingsSend = (part: string, body: Record<string, unknown>) => Promise<boolean>

export function TimeSettingsPanel({ open, onClose }: TimeSettingsPanelProps) {
  const t = useT()
  const { data, canEdit, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [view, setView] = useState<TimeSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ part: string; text: string } | null>(null)

  const ask = useCallback(async () => {
    try {
      const res = await fetch('/api/time-settings', { cache: 'no-store' })
      const value = await replyOf(res)
      if (res.ok && isTimeSettingsView(value)) {
        setView(value)
        setLoadError(null)
      } else setLoadError(String((value as { error?: unknown }).error ?? res.status))
    } catch (err) {
      setLoadError(errorText(err, latest.current.t))
    }
  }, [latest])

  // asked when it opens, and again when the board's time line moves (an entry renamed elsewhere, its counts)
  const seq = data?.time?.seq ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the store's seq moves
  useEffect(() => {
    if (open) void ask()
  }, [open, ask, seq])

  const send: TimeSettingsSend = async (part, body) => {
    setBusy(true)
    setRefusal(null)
    try {
      const res = await postJson('/api/time-settings', body)
      const reply = (await replyOf(res)) as { ok?: boolean; error?: string; moved?: number; view?: unknown }
      if (isTimeSettingsView(reply.view)) setView(reply.view)
      if (!res.ok || reply.ok === false) {
        setRefusal({ part, text: reply.error || t('err.status', { code: res.status }) })
        return false
      }
      if (body.op === 'rename' && reply.moved) toast(t('time.set.moved', { n: reply.moved }))
      return true
    } catch (err) {
      setRefusal({ part, text: errorText(err, t) })
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      id="time-settings-sheet"
      kind="timeSettings"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('time.set.title')}</h2>
          <p className="sheet-meta">{t('time.set.about')}</p>
        </>
      }
    >
      <TimeSettingsBody
        view={view}
        loadError={loadError}
        lanes={data?.categories ?? []}
        swatches={data?.swatches ?? []}
        disabled={!canEdit || busy}
        refusal={refusal}
        send={send}
      />
    </Panel>
  )
}

export interface TimeSettingsBodyProps {
  view: TimeSettingsView | null
  loadError: string | null
  lanes: BoardCategory[]
  swatches: Swatch[]
  disabled: boolean
  refusal: { part: string; text: string } | null
  send: TimeSettingsSend
}

/** The panel's content, from its view: no fetching here (TimeSettingsPanel does it). */
export function TimeSettingsBody({ view, loadError, lanes, swatches, disabled, refusal, send }: TimeSettingsBodyProps) {
  const t = useT()
  // the client opened in place; undefined until one is picked: the only client then
  const [opened, setOpened] = useState<string | null | undefined>(undefined)
  const [drafting, setDrafting] = useState(false)
  const said = (part: string) =>
    refusal?.part === part ? (
      <p className="access-problem time-set-refusal" role="alert">
        {refusal.text}
      </p>
    ) : null
  const lane = (id: string) => lanes.find(l => l.id === id)
  if (loadError)
    return (
      <div className="sheet-body cats-body time-set-body">
        <p className="access-problem" role="alert">
          {t('time.set.loadError', { error: loadError })}
        </p>
      </div>
    )
  if (!view)
    return (
      <div className="sheet-body cats-body time-set-body">
        <p className="sheet-meta">{t('time.set.loading')}</p>
      </div>
    )
  const ids = clientOrder(view, lanes)
  const without = lanesWithout(view, lanes)
  // config.json there but not JSON: what it says is shown, nothing can be changed
  const off = disabled || !!view.unreadable
  return (
    <div className="sheet-body cats-body time-set-body">
      {view.problems.length > 0 && (
        <p className="access-problem">{t('time.problemsNote', { problems: view.problems.join('; ') })}</p>
      )}
      <section className="time-set-group">
        <Switch
          label={t('time.set.on')}
          on={view.on}
          disabled={off}
          onChange={on => void send('time', { op: 'on', on })}
        />
        {!view.on && <p className="access-hint time-set-hint">{t('time.set.offHint')}</p>}
        <label className="time-field time-set-zone">
          <span>{t('time.set.zone')}</span>
          <select
            value={view.zone}
            disabled={off}
            onChange={e => void send('time', { op: 'zone', zone: e.target.value })}
          >
            {zonesOf(view.zone, view.localZone).map(z => (
              <option key={z} value={z}>
                {z.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <p className="access-hint time-set-hint">{t('time.set.zoneHint')}</p>
        {said('time')}
      </section>

      <h3 className="access-head">{t('time.set.clients')}</h3>
      {view.every ? (
        <section className="time-set-group">
          <p className="access-hint time-set-hint">{t('time.set.every')}</p>
          <div className="access-actions">
            <button
              type="button"
              className="button"
              disabled={off}
              onClick={() => void send('clients', { op: 'lanes', lanes: lanes.map(l => l.id) })}
            >
              {t('time.set.choose')}
            </button>
          </div>
          {said('clients')}
        </section>
      ) : (
        <>
          {ids.length > 0 && (
            <ul className="time-set-group time-set-clients">
              {ids.map(id => (
                <ClientRow
                  key={id}
                  id={id}
                  title={lane(id)?.title ?? id}
                  color={lane(id)?.color ?? 'var(--label-3)'}
                  c={view.clients[id] as TimeClientView}
                  open={opened === undefined ? ids.length === 1 : opened === id}
                  onToggle={() => setOpened(o => ((o === undefined ? ids.length === 1 : o === id) ? null : id))}
                  disabled={off}
                  send={send}
                  said={said}
                />
              ))}
            </ul>
          )}
          {without.length > 0 && (
            <>
              <h4 className="time-set-sub">{t('time.set.without')}</h4>
              <ul className="time-set-group time-set-lanes">
                {without.map(l => (
                  <li className="time-set-lane" key={l.id} style={{ '--lane': l.color }}>
                    <span className="time-dot">{l.title}</span>
                    <button
                      type="button"
                      className="button"
                      disabled={off}
                      onClick={async () => {
                        if (await send(`take:${l.id}`, { op: 'client', client: l.id, on: true })) setOpened(l.id)
                      }}
                    >
                      {t('time.set.take')}
                    </button>
                    {said(`take:${l.id}`)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {drafting ? (
            <div className="time-set-group time-set-draft">
              <CategoryDraft
                color={draftColor(lanes, swatches)}
                disabled={off}
                edit={body => send('lane', { ...body, op: 'newLane' })}
                onCreated={made => {
                  setDrafting(false)
                  setOpened(made.id)
                }}
                onCancel={() => setDrafting(false)}
              />
              {said('lane')}
            </div>
          ) : (
            <button
              type="button"
              className="time-add-open time-set-new"
              disabled={off}
              onClick={() => setDrafting(true)}
            >
              <PlusIcon />
              <span>{t('time.set.newLane')}</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** A switch as the entry editor's billable one: its label beside it (`bare`: for a screen reader only). */
function Switch(props: { label: string; on: boolean; disabled: boolean; onChange(on: boolean): void; bare?: boolean }) {
  return (
    <label className={classNames('time-switch', props.bare && 'time-switch-bare')}>
      <input
        type="checkbox"
        role="switch"
        checked={props.on}
        aria-checked={props.on}
        aria-label={props.bare ? props.label : undefined}
        disabled={props.disabled}
        onChange={e => props.onChange(e.target.checked)}
      />
      {!props.bare && <span>{props.label}</span>}
    </label>
  )
}

interface ClientRowProps {
  id: string
  title: string
  color: string
  c: TimeClientView
  open: boolean
  onToggle(): void
  disabled: boolean
  send: TimeSettingsSend
  said(part: string): ReactNode
}

/** A client: its head (name, what it has, its switch), opened in place to the rest. */
function ClientRow({ id, title, color, c, open, onToggle, disabled, send, said }: ClientRowProps) {
  const t = useT()
  const body = useId()
  const edit = (body: Record<string, unknown>) => send(id, { client: id, ...body })
  return (
    <li className={classNames('time-set-client', !c.on && 'off', open && 'open')} style={{ '--lane': color }}>
      <div className="time-set-client-head">
        <button
          type="button"
          className="time-set-disclose"
          aria-expanded={open}
          aria-controls={body}
          onClick={onToggle}
        >
          <ChevIcon />
          <span className="time-set-name">
            <span className="time-dot">{title}</span>
            <small>{c.on ? clientLine(c, t) : t('time.set.clientOff')}</small>
          </span>
        </button>
        <Switch
          label={t('time.set.takes')}
          bare
          on={c.on}
          disabled={disabled}
          onChange={on => void edit({ op: 'client', on })}
        />
      </div>
      {open && (
        <div className="time-set-client-body" id={body}>
          <div className="time-set-sub time-set-projects-head" style={columnsOf(c)}>
            <h5>{t('time.set.projects')}</h5>
            {c.projects?.length && c.billable ? <span>{t('time.set.projectBilled')}</span> : null}
            {c.projects?.length
              ? bySystem(c).map((s, i) => (
                  <span key={s.id} className="time-set-system-head" style={{ gridColumn: 4 + i }} title={s.title}>
                    {s.title}
                  </span>
                ))
              : null}
          </div>
          {c.projects === null ? (
            <div className="access-actions">
              <span className="access-hint time-set-hint">{t('time.set.anyProject')}</span>
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() =>
                  void edit({
                    op: 'list',
                    projects: Object.entries(c.use)
                      .sort((a, b) => b[1] - a[1])
                      .map(([p]) => p),
                  })
                }
              >
                {t('time.set.keepList')}
              </button>
            </div>
          ) : (
            <>
              {c.projects.length === 0 && <p className="access-hint time-set-hint">{t('time.set.noProjects')}</p>}
              <ul className="time-set-projects" style={columnsOf(c)}>
                {c.projects.map(p => (
                  <ProjectRow key={p} name={p} c={c} disabled={disabled} edit={edit} />
                ))}
              </ul>
              {c.projects.length > 0 && bySystem(c).length > 0 && (
                <p className="access-hint time-set-hint">{t('time.set.projectSystemsHint')}</p>
              )}
              <AddProject disabled={disabled} onAdd={name => edit({ op: 'project', name })} />
            </>
          )}
          {c.retired.length > 0 && (
            <>
              <h5 className="time-set-sub time-set-quiet">{t('time.set.retired')}</h5>
              <ul className="time-set-projects time-set-retired">
                {c.retired.map(p => (
                  <li className="time-set-project" key={p}>
                    <span className="time-set-project-name">{p}</span>
                    <Uses n={c.use[p] ?? 0} />
                    <button
                      type="button"
                      className="time-set-link"
                      disabled={disabled}
                      onClick={() => void edit({ op: 'restore', project: p })}
                    >
                      {t('time.set.restore')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="time-set-billed">
            <Switch
              label={t('time.set.billed')}
              on={c.billable}
              disabled={disabled}
              onChange={billable => void edit({ op: 'billable', billable })}
            />
          </div>
          {!c.billable && <p className="access-hint time-set-hint">{t('time.set.notBilled')}</p>}
          <h5 className="time-set-sub">{t('time.set.systems')}</h5>
          <Systems c={c} disabled={disabled} edit={edit} />
          {(c.rules > 0 || c.ref) && <p className="access-hint time-set-hint">{t('time.set.kept')}</p>}
          {said(id)}
        </div>
      )}
    </li>
  )
}

/**
 * The systems a project can be taken out of, a column each: where a client has two or more (or a
 * project has its own already, to be put back). One alone is where all of its time goes.
 */
const bySystem = (c: TimeClientView) =>
  c.systems.length > 1 || Object.keys(c.projectSystems ?? {}).length > 0 ? c.systems : []

/** The project rows' columns for those systems, named once in the heading. */
const columnsOf = (c: TimeClientView) => ({
  '--systems': bySystem(c)
    .map(() => 'var(--system-col)')
    .join(' '),
})

/** A project's live entries; its cell kept when it has none, so the row's columns stay where they are. */
function Uses({ n }: { n: number }) {
  const t = useT()
  return <small className="time-set-uses">{n ? t('time.set.entries', { n }) : ''}</small>
}

/**
 * A project: its name and entries, billable or not (a billed client's), the systems it is entered
 * in (a client's with more than one), Rename in place, Retire.
 */
function ProjectRow(props: {
  name: string
  c: TimeClientView
  disabled: boolean
  edit(body: Record<string, unknown>): Promise<boolean>
}) {
  const t = useT()
  const { name, c } = props
  const [renaming, setRenaming] = useState<string | null>(null)
  const uses = c.use[name] ?? 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (renaming === null) return
    const to = renaming.trim()
    if (!to || to === name) return setRenaming(null)
    if (await props.edit({ op: 'rename', from: name, to })) setRenaming(null)
  }
  if (renaming !== null)
    return (
      <li className="time-set-project renaming">
        <form className="time-set-rename" onSubmit={e => void submit(e)}>
          <input
            value={renaming}
            disabled={props.disabled}
            aria-label={t('time.set.renameTo', { project: name })}
            // biome-ignore lint/a11y/noAutofocus: Rename opened the field, typed into next
            autoFocus
            onChange={e => setRenaming(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setRenaming(null)
              }
            }}
          />
          <button type="submit" className="button primary" disabled={props.disabled || !renaming.trim()}>
            {t('time.set.rename')}
          </button>
          <button type="button" className="button" disabled={props.disabled} onClick={() => setRenaming(null)}>
            {t('backup.cancel')}
          </button>
        </form>
        {uses > 0 && <p className="access-hint time-set-hint">{t('time.set.moves', { n: uses })}</p>}
      </li>
    )
  const named = (key: string) => `${t(key)}: ${name}`
  return (
    <li className="time-set-project">
      <span className="time-set-project-name">{name}</span>
      <Uses n={uses} />
      <span className="time-set-check">
        {c.billable && (
          <input
            type="checkbox"
            checked={!c.nonBillable.includes(name)}
            aria-label={named('time.set.projectBilled')}
            title={t('time.set.projectBilled')}
            disabled={props.disabled}
            onChange={e => void props.edit({ op: 'projectBillable', project: name, billable: e.target.checked })}
          />
        )}
      </span>
      {bySystem(c).map(s => {
        const own = systemsOfProject(c, name).map(x => x.id)
        const label = `${t('time.set.projectEntered', { system: s.title })}: ${name}`
        return (
          <span className="time-set-check" key={s.id}>
            <input
              type="checkbox"
              checked={own.includes(s.id)}
              aria-label={label}
              title={label}
              disabled={props.disabled}
              onChange={e =>
                void props.edit({
                  op: 'projectSystems',
                  project: name,
                  systems: e.target.checked ? [...own, s.id] : own.filter(id => id !== s.id),
                })
              }
            />
          </span>
        )
      })}
      <button
        type="button"
        className="icon-button time-set-icon"
        title={t('time.set.rename')}
        aria-label={named('time.set.rename')}
        disabled={props.disabled}
        onClick={() => setRenaming(name)}
      >
        <WriteGlyph />
      </button>
      <button
        type="button"
        className="icon-button time-set-icon"
        title={t('time.set.retireHint')}
        aria-label={named('time.set.retire')}
        disabled={props.disabled}
        onClick={() => void props.edit({ op: 'retire', project: name })}
      >
        <ArchiveGlyph />
      </button>
    </li>
  )
}

function AddProject({ disabled, onAdd }: { disabled: boolean; onAdd(name: string): Promise<boolean> }) {
  const t = useT()
  const [name, setName] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() && (await onAdd(name.trim()))) setName('')
  }
  return (
    <form className="time-set-add" onSubmit={e => void submit(e)}>
      <input
        value={name}
        disabled={disabled}
        placeholder={t('time.set.addProject')}
        aria-label={t('time.set.addProject')}
        onChange={e => setName(e.target.value)}
      />
      <button type="submit" className="button" disabled={disabled || !name.trim()}>
        {t('time.set.add')}
      </button>
    </form>
  )
}

/** Where its time is entered: a token each (its name, its id when the name differs, ×), and one added. */
function Systems(props: {
  c: TimeClientView
  disabled: boolean
  edit(body: Record<string, unknown>): Promise<boolean>
}) {
  const t = useT()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const { systems } = props.c
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!id.trim()) return
    if (await props.edit({ op: 'systems', systems: [...systems, { id: id.trim(), title: title.trim() }] })) {
      setId('')
      setTitle('')
    }
  }
  return (
    <>
      {systems.length > 0 && (
        <div className="time-tags time-set-systems">
          {systems.map(s => (
            <span className="time-tag" key={s.id}>
              {s.title}
              {s.title !== s.id && <small>{s.id}</small>}
              <button
                type="button"
                aria-label={t('time.set.removeSystem', { system: s.title })}
                title={t('time.set.removeSystem', { system: s.title })}
                disabled={props.disabled}
                onClick={() => void props.edit({ op: 'systems', systems: systems.filter(x => x.id !== s.id) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <form className="time-set-add" onSubmit={e => void submit(e)}>
        <input
          value={id}
          disabled={props.disabled}
          placeholder={t('time.set.systemId')}
          aria-label={t('time.set.systemId')}
          autoCapitalize="off"
          spellCheck={false}
          onChange={e => setId(e.target.value.toLowerCase())}
        />
        <input
          value={title}
          disabled={props.disabled}
          placeholder={t('time.set.systemTitle')}
          aria-label={t('time.set.systemTitle')}
          onChange={e => setTitle(e.target.value)}
        />
        <button type="submit" className="button" disabled={props.disabled || !id.trim()}>
          {t('time.set.add')}
        </button>
      </form>
      <p className="access-hint time-set-hint">{t('time.set.systemsHint')}</p>
    </>
  )
}
