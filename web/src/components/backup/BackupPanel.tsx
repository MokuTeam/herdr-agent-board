// Settings → Backup… (#233), on the local board only: the board's database, sealed with the owner's
// passphrase, off this computer. From the top: how the backup stands (the first problem in the
// danger color, else the last good backup) and Back up now; the passphrase (typed twice, or
// changed); the folder a sync client takes off the computer, with Test; the owner's server, its
// fields (from the tunnel's when none are set), Look, Apply, Undo, "Do it myself" and Test; and
// how to restore. Each button says what it does while it runs; what it found or why it failed is
// said under it. The view is asked when the panel opens and comes back with every answer.
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { Target } from '../../../../src/core/backup.ts'
import { shortWhen } from '../../../../src/core/when-format.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type BackupPanelView,
  type BackupReply,
  isBackupView,
  lastGood,
  lookLines,
  stateLine,
} from '../../models/backup.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { CopyButton } from '../access/Snippets.tsx'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'

export interface BackupPanelProps {
  open: boolean
  onClose(): void
}

/** A line under a section: what an action found, or why it failed. */
export type Note = { text: string; lines?: string[]; error?: boolean } | null

/** What the panel's buttons ask for (BackupPanel sends each as a POST /api/backup). */
export interface BackupActions {
  now(): void
  passphrase(passphrase: string, again: string): Promise<boolean>
  folder(folder: string): void
  testFolder(): void
  server(fields: Record<string, unknown>): void
  removeServer(): void
  run(op: ServerOp, sudoPassword: string): void
  testServer(): void
  manual(): void
  newKey(): void
}

export function BackupPanel({ open, onClose }: BackupPanelProps) {
  const t = useT()
  const { data, canEdit } = useBoardContext()
  const latest = useLatest({ t })
  const [view, setView] = useState<BackupPanelView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, Note>>({})
  const [manual, setManual] = useState<{ file: string; script: string; run: string } | null>(null)
  const note = (part: string, n: Note) => setNotes(all => ({ ...all, [part]: n }))

  const ask = useCallback(async () => {
    try {
      const res = await fetch('/api/backup', { cache: 'no-store' })
      const value = await replyOf(res)
      if (res.ok && isBackupView(value)) {
        setView(value)
        setLoadError(null)
      } else
        setLoadError(
          String((value as { error?: unknown }).error ?? latest.current.t('err.status', { code: res.status })),
        )
    } catch (err) {
      setLoadError(errorText(err, latest.current.t))
    }
  }, [latest])

  // asked when it opens, and again while it is open whenever the board's backup line changes (a
  // snapshot went out, a try failed)
  const line = JSON.stringify(data?.backup ?? null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the board's backup line changes
  useEffect(() => {
    if (open) void ask()
  }, [open, ask, line])

  /** One POST: the view it answers with taken; its reply, or null when it failed (said in `part`'s note). `key`: what shows busy. */
  const send = async (
    part: string,
    op: string,
    body: Record<string, unknown> = {},
    key: string = op,
  ): Promise<BackupReply | null> => {
    setBusy(key)
    note(part, null)
    try {
      const res = await postJson('/api/backup', { op, ...body })
      const reply = (await replyOf(res)) as BackupReply
      if (isBackupView(reply.view)) setView(reply.view)
      if (!res.ok || reply.ok === false) {
        const lines = reply.look ? lookLines(reply.look, latest.current.t) : undefined
        note(part, {
          text: reply.error || latest.current.t('err.status', { code: res.status }),
          error: true,
          ...(lines && { lines }),
        })
        return null
      }
      return reply
    } catch (err) {
      note(part, { text: errorText(err, latest.current.t), error: true })
      return null
    } finally {
      setBusy(null)
    }
  }

  const actions: BackupActions = {
    now: async () => {
      const r = await send('status', 'now')
      if (r?.sent?.length)
        note('status', {
          text: t('backup.nowDone', { targets: r.sent.map(s => t(`backup.target.${s.target}`)).join(', ') }),
        })
    },
    passphrase: async (passphrase, again) => (await send('key', 'passphrase', { passphrase, again })) !== null,
    folder: folder => void send('folder', 'folder', { folder }),
    testFolder: async () => {
      const r = await send('folder', 'test', { target: 'folder' }, 'test:folder')
      if (r?.name) note('folder', { text: t('backup.tested', { name: r.name }) })
    },
    server: fields => void send('server', 'server', fields),
    removeServer: () => void send('server', 'server', { remove: true }),
    run: async (op, sudoPassword) => {
      const r = await send('server', op, { sudoPassword })
      if (!r) return
      if (op === 'look' && r.look) note('server', { text: t('backup.look'), lines: lookLines(r.look, t) })
      if (op === 'apply' || op === 'manualDone') {
        note('server', { text: t('backup.applied') })
        setManual(null)
      }
      if (op === 'undo')
        note('server', {
          text: r.run?.none
            ? t('backup.undoneNone')
            : t('backup.undone', { count: r.run?.kept?.count ?? 0, dir: r.run?.kept?.dir ?? '' }),
        })
    },
    testServer: async () => {
      const r = await send('server', 'test', { target: 'server' }, 'test:server')
      if (r?.name) note('server', { text: t('backup.tested', { name: r.name }) })
    },
    manual: async () => {
      const r = await send('server', 'manual')
      if (r?.script && r.file) setManual({ file: r.file, script: r.script, run: `sudo sh ${r.file}` })
    },
    newKey: async () => {
      const r = await send('server', 'newKey')
      if (r) note('server', { text: t('backup.newKeyDone') })
    },
  }

  return (
    <Panel
      id="backup-sheet"
      kind="backup"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('backup.title')}</h2>
          <p className="sheet-meta">{t('backup.about')}</p>
        </>
      }
    >
      <BackupBody
        view={view}
        loadError={loadError}
        busy={busy}
        notes={notes}
        manual={manual}
        canEdit={canEdit}
        actions={actions}
      />
    </Panel>
  )
}

export interface BackupBodyProps {
  /** GET /api/backup's view; null while it is asked (or could not be read: `loadError`). */
  view: BackupPanelView | null
  loadError: string | null
  /** What runs now ('now', 'look', 'test:folder'…); null: nothing. */
  busy: string | null
  notes: Record<string, Note>
  manual: { file: string; script: string; run: string } | null
  canEdit: boolean
  actions: BackupActions
}

/** The panel's content, from its view and what runs: no fetching here (BackupPanel does it). */
export function BackupBody({ view, loadError, busy, notes, manual, canEdit, actions }: BackupBodyProps) {
  const [armed, setArmed] = useState(false)
  const reset = !!view?.problems.some(p => p.kind === 'reset')
  const t = useT()
  const disabled = !canEdit || !view || busy !== null
  const last = view ? lastGood(view.states) : null
  return (
    <div className="sheet-body cats-body backup-body">
      {loadError && (
        <p className="access-problem" role="alert">
          {t('backup.loadError', { error: loadError })}
        </p>
      )}
      {!view && !loadError && <p className="sheet-meta">{t('backup.loading')}</p>}
      {view && (
        <section className="backup-status" aria-live="polite">
          {!view.needed && <p className="access-hint">{t('backup.nothing')}</p>}
          {view.problems.map(p => (
            <p className="access-problem backup-problem" key={p.kind + p.text}>
              {p.text}
            </p>
          ))}
          {view.needed && !view.problems.length && (
            <p className="access-status">
              {last ? t('backup.lastGood', { when: shortWhen(last, t) }) : t('backup.notYet')}
            </p>
          )}
          {view.needed && (
            <div className="access-actions">
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() => {
                  // the database holds less than its last backup: sending it is a choice, asked twice
                  if (reset && !armed) return setArmed(true)
                  setArmed(false)
                  actions.now()
                }}
              >
                {busy === 'now' ? '…' : t(reset && armed ? 'backup.nowReset' : 'backup.now')}
              </button>
            </div>
          )}
          <NoteLine note={notes.status} />
        </section>
      )}
      {view && (
        <Passphrase view={view} disabled={disabled} saving={busy === 'passphrase'} onSave={actions.passphrase} />
      )}
      <NoteLine note={notes.key} />
      {view && (
        <FolderSection
          view={view}
          disabled={disabled}
          busy={busy}
          onSave={actions.folder}
          onTest={actions.testFolder}
        />
      )}
      <NoteLine note={notes.folder} />
      {view && (
        <ServerSection
          view={view}
          disabled={disabled}
          busy={busy}
          manual={manual}
          onSave={actions.server}
          onRemove={actions.removeServer}
          onRun={actions.run}
          onTest={actions.testServer}
          onManual={actions.manual}
          onNewKey={actions.newKey}
        />
      )}
      <NoteLine note={notes.server} />
      <p className="access-hint backup-restore">{t('backup.restoreHint')}</p>
    </div>
  )
}

function NoteLine({ note }: { note: Note | undefined }) {
  if (!note) return null
  return (
    <div className={classNames('backup-note', note.error && 'access-warn')} role={note.error ? 'alert' : 'status'}>
      <p>{note.text}</p>
      {note.lines && (
        <ul className="access-steps">
          {note.lines.map(l => (
            <li className="access-step" key={l}>
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Passphrase(props: {
  view: BackupPanelView
  disabled: boolean
  saving: boolean
  onSave(passphrase: string, again: string): Promise<boolean>
}) {
  const t = useT()
  const { view } = props
  const [editing, setEditing] = useState(false)
  const [first, setFirst] = useState('')
  const [again, setAgain] = useState('')
  const showForm = !view.key || editing
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (await props.onSave(first, again)) {
      setFirst('')
      setAgain('')
      setEditing(false)
    }
  }
  return (
    <section className="backup-section">
      <h3 className="access-head">{t('backup.key.title')}</h3>
      <p className="access-hint">{t('backup.key.hint')}</p>
      {view.key && !editing && (
        <div className="access-actions">
          <span className="backup-state">{t('backup.key.set', { when: shortWhen(view.key.made, t) })}</span>
          <button type="button" className="button" disabled={props.disabled} onClick={() => setEditing(true)}>
            {t('backup.key.change')}
          </button>
        </div>
      )}
      {showForm && (
        <form className="access-fields" onSubmit={e => void submit(e)}>
          {view.key && <p className="access-hint">{t('backup.key.changeHint')}</p>}
          <label className="access-field">
            <span>{t('backup.key.new')}</span>
            <input
              className="path-add"
              type="password"
              autoComplete="new-password"
              value={first}
              disabled={props.disabled}
              onChange={e => setFirst(e.target.value)}
            />
          </label>
          <label className="access-field">
            <span>{t('backup.key.again')}</span>
            <input
              className="path-add"
              type="password"
              autoComplete="new-password"
              value={again}
              disabled={props.disabled}
              onChange={e => setAgain(e.target.value)}
            />
          </label>
          <div className="access-actions">
            <button type="submit" className="button primary" disabled={props.disabled || !first || !again}>
              {props.saving ? t('backup.key.saving') : t('backup.save')}
            </button>
            {view.key && (
              <button type="button" className="button" onClick={() => setEditing(false)}>
                {t('backup.cancel')}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  )
}

function TargetState({ view, target }: { view: BackupPanelView; target: Target }) {
  const t = useT()
  const s = stateLine(view.states[target], t)
  return (
    <>
      <p className="backup-state">{s.line}</p>
      {s.error && <p className="access-problem">{s.error}</p>}
    </>
  )
}

function FolderSection(props: {
  view: BackupPanelView
  disabled: boolean
  busy: string | null
  onSave(folder: string): void
  onTest(): void
}) {
  const t = useT()
  const saved = props.view.config.folder ?? ''
  const [folder, setFolder] = useState(saved)
  useEffect(() => setFolder(saved), [saved])
  return (
    <section className="backup-section">
      <h3 className="access-head">{t('backup.folder.title')}</h3>
      <p className="access-hint">{t('backup.folder.hint')}</p>
      <label className="access-field backup-wide">
        <input
          className="path-add"
          value={folder}
          placeholder={t('backup.folder.placeholder')}
          disabled={props.disabled}
          onChange={e => setFolder(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && folder.trim() !== saved) props.onSave(folder.trim())
            if (e.key === 'Escape') setFolder(saved)
          }}
        />
      </label>
      <div className="access-actions">
        <button
          type="button"
          className="button primary"
          disabled={props.disabled || folder.trim() === saved}
          onClick={() => props.onSave(folder.trim())}
        >
          {t('backup.save')}
        </button>
        {saved && (
          <>
            <button
              type="button"
              className="button"
              disabled={props.disabled || !props.view.key}
              onClick={props.onTest}
            >
              {props.busy === 'test:folder' ? t('backup.testing') : t('backup.test')}
            </button>
            <button type="button" className="button" disabled={props.disabled} onClick={() => props.onSave('')}>
              {t('backup.remove')}
            </button>
          </>
        )}
      </div>
      {saved && <TargetState view={props.view} target="folder" />}
    </section>
  )
}

export type ServerOp = 'look' | 'apply' | 'undo' | 'manualDone'

function ServerSection(props: {
  view: BackupPanelView
  disabled: boolean
  busy: string | null
  manual: { file: string; script: string; run: string } | null
  onSave(fields: Record<string, unknown>): void
  onRemove(): void
  onRun(op: ServerOp, sudoPassword: string): void
  onTest(): void
  onManual(): void
  onNewKey(): void
}) {
  const t = useT()
  const { view, busy } = props
  const s = view.config.server
  const start = s
    ? { host: s.host, port: String(s.port), adminUser: s.admin.user, adminKey: s.admin.key }
    : view.suggest
      ? { ...view.suggest, port: String(view.suggest.port) }
      : { host: '', port: '22', adminUser: '', adminKey: '' }
  const [fields, setFields] = useState(start)
  const startKey = JSON.stringify(start)
  useEffect(() => setFields(JSON.parse(startKey)), [startKey])
  const [sudo, setSudo] = useState('')
  const changed =
    !s ||
    s.host !== fields.host ||
    String(s.port) !== fields.port ||
    s.admin.user !== fields.adminUser ||
    s.admin.key !== fields.adminKey
  const field = (name: keyof typeof fields, label: string, type = 'text') => (
    <label className="access-field" key={name}>
      <span>{label}</span>
      <input
        className="path-add"
        type={type}
        value={fields[name]}
        // a server that takes snapshots keeps its address: Undo first; its admin login may change
        disabled={props.disabled || (!!s?.set && (name === 'host' || name === 'port'))}
        onChange={e => setFields(f => ({ ...f, [name]: e.target.value }))}
      />
    </label>
  )
  const label = (op: string, idle: string, running: string) => (busy === op ? t(running) : t(idle))
  return (
    <section className="backup-section">
      <h3 className="access-head">{t('backup.server.title')}</h3>
      <p className="access-hint">{t('backup.server.hint')}</p>
      <div className="access-fields">
        {field('host', t('backup.field.host'))}
        {field('port', t('backup.field.port'))}
        {field('adminUser', t('backup.field.adminUser'))}
        {field('adminKey', t('backup.field.adminKey'))}
      </div>
      <div className="access-actions">
        <button
          type="button"
          className="button primary"
          disabled={props.disabled || !changed || !fields.host}
          onClick={() => props.onSave({ ...fields, port: Number(fields.port) || 22 })}
        >
          {t('backup.save')}
        </button>
        {s && (
          <button type="button" className="button" disabled={props.disabled || !!s.set} onClick={props.onRemove}>
            {t('backup.remove')}
          </button>
        )}
      </div>
      {s && !changed && (
        <>
          <p className={classNames('backup-state', !s.set && 'access-why')}>
            {s.set ? t('backup.serverSet', { when: shortWhen(Date.parse(s.set), t) }) : t('backup.serverNotSet')}
          </p>
          <label className="access-field">
            <span>{t('backup.field.sudoPassword')}</span>
            <input
              className="path-add"
              type="password"
              autoComplete="off"
              value={sudo}
              disabled={props.disabled}
              onChange={e => setSudo(e.target.value)}
            />
          </label>
          <div className="access-actions">
            <button
              type="button"
              className="button"
              disabled={props.disabled}
              onClick={() => props.onRun('look', sudo)}
            >
              {label('look', 'backup.look', 'backup.looking')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={props.disabled || !view.key}
              onClick={() => props.onRun('apply', sudo)}
            >
              {label('apply', 'backup.apply', 'backup.applying')}
            </button>
            {s.set && (
              <button type="button" className="button" disabled={props.disabled} onClick={props.onTest}>
                {busy === 'test:server' ? t('backup.testing') : t('backup.test')}
              </button>
            )}
            <button
              type="button"
              className="button"
              disabled={props.disabled}
              onClick={() => props.onRun('undo', sudo)}
            >
              {label('undo', 'backup.undo', 'backup.undoing')}
            </button>
            <button type="button" className="button" disabled={props.disabled} onClick={props.onManual}>
              {t('backup.manual')}
            </button>
          </div>
          {s.set && <TargetState view={view} target="server" />}
          {view.dropKey && (
            <div className="access-actions">
              <span className="access-hint">{t('backup.newKeyHint')}</span>
              <button type="button" className="button" disabled={props.disabled} onClick={props.onNewKey}>
                {t('backup.newKey')}
              </button>
            </div>
          )}
          {props.manual && (
            <div className="backup-manual">
              <p className="access-hint">
                {t('backup.manualHint', { file: props.manual.file, run: props.manual.run })}
              </p>
              <pre className="backup-script">{props.manual.script}</pre>
              <div className="access-actions">
                <CopyButton text={props.manual.script} />
                <button
                  type="button"
                  className="button primary"
                  disabled={props.disabled || !view.key}
                  onClick={() => props.onRun('manualDone', sudo)}
                >
                  {t('backup.manualDone')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
