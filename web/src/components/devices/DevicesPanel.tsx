// Settings, Devices (#510, docs/design/nodes 12), on the local page of a board whose config.json has
// `nodes`: the devices in the order new sessions fill them, this computer among them, dragged to
// reorder (hooks/useRowReorder.ts, as the lanes are) or moved with the up and down arrows on the
// handle. Per device its link in words, bars of the sessions awake and the memory free against its
// thresholds, its version (and on another version than this board's, Update, #590), the secrets its
// syncs gave (#604), what an agent there cannot do for want of git, an identity, a GitHub login or gh
// (#609), Pause, Drain and Give it the secrets, and the three thresholds as fields with the board's own
// figures as placeholders. Then the lanes that may leave this computer and what a start does when
// every device is full. The devices' live state comes with the payload (`devices`); the section's
// own keys and the board's figures from GET /api/nodes, asked at each opening and answered again
// by every change. Every change goes to config.json at once (POST /api/nodes) and comes back over
// the live stream. On a node's own page the payload carries its master's devices (#786,
// `relayedDevices`): the same panel, its changes and Add a server / Add a computer going to the
// master over the relay; Move master role stays on the master.
import { type FocusEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, errorText } from '../../api/client.ts'
import { useHeld } from '../../hooks/useHeld.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useRowReorder } from '../../hooks/useRowReorder.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { ComputerSetupView } from '../../models/computer-setup.ts'
import {
  DEVICE_COLORS,
  type DeviceRow,
  deviceRows,
  deviceTitleEdited,
  isPanelReply,
  lanesAfter,
  laneTicks,
  movedOrder,
  type PanelSettings,
  refusedText,
  THRESHOLDS,
  type Threshold,
  thresholdTyped,
} from '../../models/devices.ts'
import type { HandoverView } from '../../models/master-handover.ts'
import type { NodeSetupView } from '../../models/node-setup.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { GripGlyph, PencilIcon } from '../icons.tsx'
import { Panel, type PanelBack } from '../panel/Panel.tsx'
import { Switch } from '../team/Switch.tsx'
import { AddComputer } from './AddComputer.tsx'
import { AddServer, LoginLines } from './AddServer.tsx'
import { MasterHandover } from './MasterHandover.tsx'

export interface DevicesPanelProps {
  open: boolean
  onClose(): void
  back?: PanelBack | undefined
  /** What GET /api/nodes said, for a test that draws the panel without a server. */
  initial?: PanelSettings
  /** The Add a server form's view, for a test (components/devices/AddServer.tsx). */
  setup?: NodeSetupView
  /** The Add a computer form's view, for a test (components/devices/AddComputer.tsx). */
  computerSetup?: ComputerSetupView
  /** The Move master role view, for a test (components/devices/MasterHandover.tsx). */
  handover?: HandoverView
}

/** How long the panel waits after the devices change before it asks for the next device again. */
const NEXT_MS = 1000

/** POST /api/nodes; the settings it answered with, or null when it was refused (a toast says why). */
type Send = (body: Record<string, unknown>) => Promise<PanelSettings | null>

export function DevicesPanel({ open, onClose, back, initial, setup, computerSetup, handover }: DevicesPanelProps) {
  const t = useT()
  const { data, canEdit, toast, now } = useBoardContext()
  const [settings, setSettings] = useState<PanelSettings | null>(initial ?? null)
  // An order just dropped, shown until the payload brings it.
  const [order, setOrder] = useState<string[] | null>(null)
  // The device whose colour swatches are open; at most one at a time.
  const [palette, setPalette] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const latest = useLatest({ canEdit, t, toast })

  const refresh = useCallback(() => {
    api
      .get('/api/nodes', isPanelReply, { cache: 'no-store' })
      .then(r => r.settings && setSettings(r.settings))
      .catch(() => {})
  }, [])
  // a board without `nodes` has no section to read: it is asked nothing until Add a server opens
  const master = !!data?.devices
  // a node and not a master (the payload's machine, #701): devices are added on the master (#777)
  const nodeOnly = !master && !!data?.machine
  // a node's own page with its master's devices (#786): this computer is the row with no link
  const relayed = data?.relayedDevices ?? null
  useEffect(() => {
    if (open && master) refresh()
    if (!open) setPalette(null)
  }, [open, master, refresh])

  const send: Send = useCallback(
    async body => {
      const { canEdit, t, toast } = latest.current
      if (!canEdit) return null
      // A lane ticked shows at once, so the next tick builds on it.
      const lanes = body.lanes
      if (body.op === 'lanes' && (lanes === 'all' || Array.isArray(lanes)))
        setSettings(s => s && { ...s, lanes: lanes as PanelSettings['lanes'] })
      try {
        const r = await api.post('/api/nodes', body, isPanelReply)
        if (r.settings) setSettings(r.settings)
        return r.settings ?? null
      } catch (err) {
        const refused = err instanceof ApiError ? refusedText(err.status, err.reply.error, t) : null
        toast(refused ?? errorText(err, t), true)
        refresh()
        return null
      }
    },
    [latest, refresh],
  )

  const devices = data?.devices
  // Sessions starting and ending, a device paused or gone: the next device is asked again.
  const room = (devices ?? [])
    .map(d => [d.id, d.link?.state, d.status?.sessions.awake, d.status?.memAvailableMb, d.paused, d.drain].join(':'))
    .join('\n')
  useEffect(() => {
    if (!open || !room) return
    const timer = setTimeout(refresh, NEXT_MS)
    return () => clearTimeout(timer)
  }, [open, room, refresh])
  // The order dropped stays until the payload has it.
  const live = (devices ?? []).map(d => d.id).join('\n')
  useEffect(() => {
    if (order && order.join('\n') === live) setOrder(null)
  }, [live, order])
  const reorder = useRowReorder(list, '.handle', {
    onLift: () => {},
    onDrop(rows, from, to) {
      if (to === from) return
      const ids = rows.map(row => row.dataset.id ?? '')
      setOrder(ids)
      void send({ op: 'order', ids }).then(r => r || setOrder(null))
    },
  })
  // Update (#590): the row says how it goes from the payload; only a request the board would not
  // take at all (no such device, an old board) is a toast.
  const update = useCallback(
    (id: string) => {
      const { canEdit, t, toast } = latest.current
      if (!canEdit) return
      api.post('/api/nodes', { op: 'update', id }).catch(err => {
        if (err instanceof ApiError && (err.status === 502 || err.status === 409)) return
        const refused = err instanceof ApiError ? refusedText(err.status, err.reply.error, t) : null
        toast(refused ?? errorText(err, t), true)
      })
    },
    [latest],
  )
  const held = useHeld(devices, reorder.dragging)
  // without `nodes` the panel holds Add a server alone: a board adds its first server here (#509)
  const shown = held ?? []
  const hasRelay = master && settings !== null ? !!settings.relay : undefined
  const rows = deviceRows(shown, now, t, settings, data?.schedules, data?.items)
  if (order) rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const ids = rows.map(r => r.id)
  const move = (id: string, by: number) => {
    const next = movedOrder(ids, id, by)
    if (next.join('\n') === ids.join('\n')) return
    setOrder(next)
    void send({ op: 'order', ids: next }).then(r => r || setOrder(null))
  }

  return (
    <Panel
      id="devices-sheet"
      kind="devices"
      back={back}
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('node.dev.title')}</h2>
          {master && <p className="sheet-meta">{t('node.dev.about')}</p>}
        </>
      }
    >
      <div className="sheet-body cats-body devices-body">
        {!master && (
          <p className="sheet-meta devices-none">
            {!nodeOnly
              ? t('node.add.none')
              : data?.nodeMaster?.name
                ? t('node.add.onNodeNamed', { master: data.nodeMaster.name })
                : t('node.add.onNode')}
          </p>
        )}
        <div className="cats-list devices-list" ref={list}>
          {rows.map(row => (
            <DeviceRowView
              key={row.id}
              row={row}
              open={open}
              defaults={settings?.defaults[row.id]}
              next={settings?.next === row.id}
              paletteOpen={palette === row.id}
              onTogglePalette={() => setPalette(was => (was === row.id ? null : row.id))}
              disabled={!canEdit}
              send={send}
              onMove={by => move(row.id, by)}
              onUpdate={() => update(row.id)}
              role={
                relayed
                  ? row.here
                    ? t('node.dev.here')
                    : row.id === relayed.master
                      ? t('node.dev.master')
                      : null
                  : row.here
                    ? t('node.dev.master')
                    : null
              }
            />
          ))}
        </div>
        {!nodeOnly && <AddServer open={open} {...(setup && { initial: setup })} />}
        {!nodeOnly && (
          <AddComputer
            open={open}
            devices={shown}
            {...(hasRelay !== undefined && { hasRelay })}
            {...(computerSetup && { initial: computerSetup })}
          />
        )}
        {/* Moving the master role is done on the master (#786: a node's page shows its devices, relayed). */}
        {master && !relayed && <MasterHandover open={open} devices={shown} {...(handover && { initial: handover })} />}
        {master && <LanesSection settings={settings} disabled={!canEdit} send={send} />}
        {master && (
          <section className="devices-section">
            <h3 className="devices-head">{t('node.dev.full')}</h3>
            <div className="devices-switch-row">
              <span>{t('node.dev.fullLocal')}</span>
              <Switch
                name="whenFull"
                label={t('node.dev.fullLocal')}
                on={(settings?.whenFull ?? 'local') === 'local'}
                disabled={!canEdit || !settings}
                onFlip={on => void send({ op: 'whenFull', whenFull: on ? 'local' : 'wait' })}
              />
            </div>
            <p className="sheet-meta">{t('node.dev.fullAbout')}</p>
          </section>
        )}
      </div>
    </Panel>
  )
}

interface RowProps {
  row: DeviceRow
  open: boolean
  /** The board's own figures for its thresholds: the placeholders. */
  defaults: Record<Threshold, number> | undefined
  /** The next start would go here: a quiet mark. */
  next: boolean
  paletteOpen: boolean
  onTogglePalette(): void
  disabled: boolean
  send: Send
  onMove(by: number): void
  /** Ships this board's version to the device now (#590). */
  onUpdate(): void
  /** The row's role beside its title: the master's own, or this computer on a node's page (#786); null for none. */
  role: string | null
}

/** One device: handle, colour legend/picker, title and link, the bars, the version, Pause and Drain, the thresholds. */
function DeviceRowView({
  row,
  open,
  defaults,
  next,
  paletteOpen,
  onTogglePalette,
  disabled,
  send,
  onMove,
  onUpdate,
  role,
}: RowProps) {
  const t = useT()
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState<{ title: string; was: string } | null>(null)
  const [pendingColor, setPendingColor] = useState<{ colorId: string; color: string; was: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleBtnRef = useRef<HTMLButtonElement>(null)
  const doneRef = useRef(false)
  const wasEditing = useRef(false)
  const returnFocusRef = useRef(false)

  useEffect(() => {
    if (!open) {
      returnFocusRef.current = false
      setEditing(null)
    }
  }, [open])

  useEffect(() => {
    if (pending && row.rawTitle !== pending.was) setPending(null)
  }, [pending, row.rawTitle])

  useEffect(() => {
    if (pendingColor && row.colorId !== pendingColor.was) setPendingColor(null)
  }, [pendingColor, row.colorId])

  useEffect(() => {
    const now = editing !== null
    if (now && !wasEditing.current) {
      inputRef.current?.focus?.()
      inputRef.current?.select?.()
    } else if (!now && wasEditing.current && returnFocusRef.current) {
      returnFocusRef.current = false
      titleBtnRef.current?.focus?.()
    }
    wasEditing.current = now
  }, [editing])

  const activePending = pending && pending.was === row.rawTitle ? pending : null
  const currentRaw = activePending ? activePending.title : row.rawTitle
  const shownTitle = activePending ? activePending.title || row.defaultTitle : row.title
  const activeColor = pendingColor && pendingColor.was === row.colorId ? pendingColor : null
  const shownColorId = activeColor ? activeColor.colorId : row.colorId
  const shownColorHex = activeColor ? activeColor.color : row.color

  const pickColor = (id: string) => {
    onTogglePalette()
    if (disabled || id === shownColorId) return
    const hex = DEVICE_COLORS.find(s => s.id === id)?.hex ?? row.color
    const entry = { colorId: id, color: hex, was: row.colorId }
    setPendingColor(entry)
    void send({ op: 'set', id: row.id, color: id }).then(r => {
      if (!r) setPendingColor(p => (p === entry ? null : p))
    })
  }

  const startEdit = () => {
    if (disabled) return
    doneRef.current = false
    returnFocusRef.current = false
    const initial = activePending
      ? activePending.title || (row.here ? '' : row.id)
      : row.here
        ? row.rawTitle
        : row.rawTitle || row.id
    setEditing(initial)
  }

  const commit = (value: string) => {
    doneRef.current = true
    setEditing(null)
    const nextTitle = deviceTitleEdited(row.id, currentRaw, value, row.defaultTitle)
    if (nextTitle === null) return
    const entry = { title: nextTitle, was: row.rawTitle }
    setPending(entry)
    void send({ op: 'set', id: row.id, title: nextTitle }).then(r => {
      if (!r) setPending(p => (p === entry ? null : p))
    })
  }

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent?.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      returnFocusRef.current = true
      commit(e.currentTarget.value)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      returnFocusRef.current = true
      doneRef.current = true
      setEditing(null)
    }
  }

  const onTitleBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (doneRef.current) {
      doneRef.current = false
      return
    }
    returnFocusRef.current = false
    commit(e.currentTarget.value)
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    onMove(e.key === 'ArrowUp' ? -1 : 1)
  }
  return (
    <div
      className={classNames('devices-row', row.here && 'here', (row.paused || row.drain) && 'held')}
      data-id={row.id}
      data-link={row.linkState ?? undefined}
    >
      <div className="devices-main">
        <button
          type="button"
          className="handle"
          title={t('node.dev.handle')}
          aria-label={t('node.dev.order', { name: shownTitle })}
          disabled={disabled}
          onKeyDown={onKey}
        >
          <GripGlyph />
        </button>
        <button
          type="button"
          className="devices-color"
          style={{ '--device': shownColorHex }}
          title={t('node.dev.colorPick')}
          aria-label={t('node.dev.colorOf', { name: shownTitle })}
          aria-expanded={paletteOpen}
          disabled={disabled}
          onClick={onTogglePalette}
        />
        <div className="devices-name">
          {editing !== null ? (
            <input
              ref={inputRef}
              type="text"
              className="devices-title-input"
              maxLength={200}
              spellCheck={false}
              value={editing}
              placeholder={row.defaultTitle}
              aria-label={t('node.dev.renameLabel')}
              disabled={disabled}
              onChange={e => setEditing(e.currentTarget.value)}
              onKeyDown={onTitleKey}
              onBlur={onTitleBlur}
            />
          ) : (
            <button
              ref={titleBtnRef}
              type="button"
              className="devices-title"
              title={t('node.dev.rename')}
              aria-label={t('node.dev.renameOf', { name: shownTitle })}
              disabled={disabled}
              onClick={startEdit}
            >
              <strong>{shownTitle}</strong>
              <span className="devices-title-edit" aria-hidden="true">
                <PencilIcon />
              </span>
            </button>
          )}
          {role && <span className="devices-role">{role}</span>}
          {row.link && <span className="devices-link">{row.link}</span>}
          {next && <span className="devices-next">{t('node.dev.next')}</span>}
        </div>
      </div>
      {paletteOpen && (
        <div className="devices-palette">
          {DEVICE_COLORS.map(sw => (
            <button
              type="button"
              key={sw.id}
              className="devices-sw"
              data-color={sw.id}
              style={{ '--sw': sw.hex }}
              title={sw.id}
              aria-label={sw.id}
              aria-pressed={shownColorId === sw.id}
              disabled={disabled}
              onClick={() => pickColor(sw.id)}
            />
          ))}
        </div>
      )}
      {row.sessions || row.memory ? (
        <div className="devices-bars">
          {row.sessions && (
            <div className="devices-bar">
              <span className="devices-meter" aria-hidden="true">
                {row.sessions.share !== null && (
                  <span className="devices-fill" style={{ '--share': row.sessions.share }} />
                )}
              </span>
              <span className="devices-figure">{row.sessions.text}</span>
            </div>
          )}
          {row.memory && (
            <div className={classNames('devices-bar', row.memory.low && 'low')}>
              <span className="devices-meter" aria-hidden="true">
                <span className="devices-fill" style={{ '--share': row.memory.share }} />
                {row.memory.floor !== null && (
                  <span className="devices-floor" style={{ '--share': row.memory.floor }} />
                )}
              </span>
              <span className="devices-figure">{row.memory.text}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="sheet-meta devices-facts">{t('node.dev.noStatus')}</p>
      )}
      {(row.version || row.bundles.length > 0 || row.secrets.length > 0) && (
        <p className="sheet-meta devices-facts">
          {row.version && (
            <span>
              {t('node.dev.version', { v: row.version })}
              {row.same !== null && (
                <span className={classNames('devices-same', !row.same && 'other')}>
                  {' · '}
                  {row.same ? t('node.dev.versionSame') : t('node.dev.versionOther')}
                </span>
              )}
            </span>
          )}
          {row.bundles.map(b => (
            <span key={b}>{b}</span>
          ))}
          {row.secrets.map(s => (
            <span key={s}>{s}</span>
          ))}
        </p>
      )}
      {row.update && (
        <div className={classNames('devices-update', row.update.state)}>
          <span className="sheet-meta">{row.update.text}</span>
          {row.update.offer && (
            <button
              type="button"
              className="devices-update-go"
              title={t('node.dev.updateWhy')}
              disabled={disabled}
              onClick={onUpdate}
            >
              {t('node.dev.update')}
            </button>
          )}
        </div>
      )}
      {row.git.length > 0 && (
        <p className="sheet-meta devices-facts">
          {row.git.map(s => (
            <span key={s}>{s}</span>
          ))}
        </p>
      )}
      {row.held && (
        <div className="devices-held">
          <span className="sheet-meta devices-held-count">{row.held.label}</span>
          {row.held.entries.length > 0 && (
            <ul className="devices-held-list">
              {row.held.entries.map(e => (
                <li className="devices-held-item" key={e.id}>
                  <span className="devices-held-who">{e.who}</span>
                  {e.text && <span className="devices-held-text">{e.text}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {row.login && (
        <div className="devices-login">
          <LoginLines device={shownTitle} out={row.login.out} command={row.login.command} />
        </div>
      )}
      <div className="devices-controls">
        {!row.here && (
          <div className="devices-switch-row" title={t('node.dev.pauseWhy')}>
            <span>{t('node.dev.pause')}</span>
            <Switch
              name="paused"
              label={t('node.dev.pause')}
              on={row.paused}
              disabled={disabled}
              onFlip={on => void send({ op: 'set', id: row.id, paused: on })}
            />
          </div>
        )}
        <div className="devices-switch-row" title={t('node.dev.drainWhy')}>
          <span>{t('node.dev.drain')}</span>
          <Switch
            name="drain"
            label={t('node.dev.drain')}
            on={row.drain}
            disabled={disabled}
            onFlip={on => void send({ op: 'set', id: row.id, drain: on })}
          />
        </div>
        {!row.here && (
          <div className="devices-switch-row" title={t('node.dev.secretsWhy')}>
            <span>{t('node.dev.secrets')}</span>
            <Switch
              name="giveSecrets"
              label={t('node.dev.secrets')}
              on={row.giveSecrets}
              disabled={disabled}
              onFlip={on => void send({ op: 'set', id: row.id, giveSecrets: on })}
            />
          </div>
        )}
      </div>
      <div className="devices-limits" title={t('node.dev.thresholdsWhy')}>
        {THRESHOLDS.map(key => (
          <ThresholdField
            key={`${key}:${row.values[key] ?? ''}`}
            name={key}
            value={row.values[key]}
            dflt={defaults?.[key]}
            disabled={disabled}
            onSave={async n => (await send({ op: 'set', id: row.id, [key]: n })) !== null}
          />
        ))}
      </div>
    </div>
  )
}

/** A threshold: saved when the field is left or on Enter; Escape puts it back. */
function ThresholdField(props: {
  name: Threshold
  value: number | null
  dflt: number | undefined
  disabled: boolean
  /** Whether the board took it; a refusal puts the field back. */
  onSave(n: number): Promise<boolean>
}) {
  const t = useT()
  const escaping = useRef(false)
  return (
    <label className="devices-limit">
      <span>{t(`node.dev.${props.name}`)}</span>
      <input
        type="number"
        inputMode="decimal"
        min={props.name === 'maxSessions' ? 1 : 0}
        step={props.name === 'maxLoad' ? 0.1 : 1}
        defaultValue={props.value ?? ''}
        placeholder={props.dflt === undefined ? '' : String(props.dflt)}
        disabled={props.disabled}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            escaping.current = true
            e.currentTarget.blur()
          }
        }}
        onBlur={e => {
          const field = e.currentTarget
          const back = () => {
            field.value = props.value === null ? '' : String(props.value)
          }
          // A number the field cannot read ("1e") reads as empty: it is put back, not taken as empty.
          const typed = escaping.current || field.validity?.badInput ? null : field.value
          escaping.current = false
          const n = typed === null ? null : thresholdTyped(props.name, typed, props.dflt, props.value)
          if (n === null) back()
          else
            void props.onSave(n).then(ok => {
              if (!ok) back()
            })
        }}
      />
    </label>
  )
}

/** "Lanes that may leave this computer": a tick per lane in its colour, and All. */
function LanesSection({ settings, disabled, send }: { settings: PanelSettings | null; disabled: boolean; send: Send }) {
  const t = useT()
  const { data } = useBoardContext()
  const categories = data?.categories ?? []
  const lanes = settings?.lanes ?? []
  const ticks = laneTicks(categories, lanes, settings?.seen ?? null)
  const shown = categories.map(c => c.id)
  const off = disabled || !settings
  return (
    <section className="devices-section">
      <h3 className="devices-head">{t('node.dev.lanes')}</h3>
      <p className="sheet-meta">{t('node.dev.lanesAbout')}</p>
      <div className="devices-lanes">
        <label className="devices-lane all">
          <input
            type="checkbox"
            checked={lanes === 'all'}
            disabled={off}
            onChange={e => void send({ op: 'lanes', lanes: e.currentTarget.checked ? 'all' : [], shown })}
          />
          <span>{t('node.dev.lanesAll')}</span>
        </label>
        {ticks.map(l => (
          <label className={classNames('devices-lane', l.fresh && 'fresh')} key={l.id} style={{ '--lane': l.color }}>
            <input
              type="checkbox"
              checked={l.ticked}
              disabled={off}
              onChange={e =>
                void send({ op: 'lanes', lanes: lanesAfter(lanes, shown, l.id, e.currentTarget.checked), shown })
              }
            />
            <span className="devices-swatch" aria-hidden="true" />
            <span>{l.title}</span>
            {l.fresh && <span className="devices-new">{t('node.dev.laneNew')}</span>}
          </label>
        ))}
      </div>
    </section>
  )
}
