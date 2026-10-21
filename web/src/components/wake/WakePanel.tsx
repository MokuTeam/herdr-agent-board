// Settings → Sleep and wake… (#119), a panel like Phones… and Profiles…, drawn while the payload
// carries wake's state line (wake shipped, turned on, or sessions still asleep in its file): the
// switch, the state line and the buttons its state offers (Start; Start again and Log), the shown
// profiles that lack wake's hooks with Install (or have the separate plugin's), the reaper (on or
// off, the minutes idle, the names never put to sleep, each saved when its field is left) and
// Telegram (Auto or Off, what it found, what its router does while wake runs; Install claude-tg
// once it is Auto and found tg-mcp). While the separate herdr-wake plugin holds wake: Switch over…,
// asked once, then what it took over. What the takeover at wake's first start did (nobody asked:
// the reaper and Telegram left off), until "Got it". Every change goes to the board at once
// (hooks/useWake.ts) and comes back over the live stream. On a phone: the state line, read only.
import type { Switched, WakeSettingsView, WakeView } from '../../../../src/core/wake/view.ts'
import { useWake, type WakeActions } from '../../hooks/useWake.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { remotePage } from '../../models/remote-page.ts'
import {
  excludeEdited,
  hookNotes,
  isWakeView,
  minutesEdited,
  routerLine,
  stateLine,
  switchedLines,
  switchOffered,
  takenOverLines,
  telegramLine,
  type WakeButton,
  wakeButtons,
  withPending,
} from '../../models/wake.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface WakePanelProps {
  open: boolean
  onClose(): void
}

export function WakePanel({ open, onClose }: WakePanelProps) {
  const t = useT()
  const { data, canEdit, now } = useBoardContext()
  const phone = remotePage()
  const wake = useWake(open && !phone)
  const { view, settings } = withPending(isWakeView(data?.wake) ? data.wake : undefined, wake.settings, wake.pending)
  if (!view) return null
  return (
    <Panel
      id="wake-sheet"
      kind="wake"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('wake.title')}</h2>
          <p className="sheet-meta">{t('wake.switchHint')}</p>
        </>
      }
    >
      <WakeBody
        view={view}
        settings={settings}
        log={wake.log}
        switched={wake.switched}
        asking={wake.asking}
        onAsking={wake.ask}
        phone={phone}
        canEdit={canEdit}
        now={now}
        act={wake.act}
      />
    </Panel>
  )
}

export interface WakeBodyProps {
  view: WakeView
  /** GET /api/wake's; null until it answered (the reaper and Telegram wait for it). */
  settings: WakeSettingsView | null
  /** wake.log's last lines, once Log was pressed. */
  log: string | null
  /** What Switch over… took over, once it went through. */
  switched?: Switched | null
  /** Switch over… asks before it goes: its question is up. */
  asking?: boolean
  onAsking?(asking: boolean): void
  /** The board in a phone's browser: the state line only. */
  phone: boolean
  canEdit: boolean
  now: number
  act: WakeActions
}

const BUTTON: Record<WakeButton, string> = { start: 'wake.start', again: 'wake.again', log: 'wake.log' }

/** The panel's content, as drawn for wake's state and settings. */
export function WakeBody(props: WakeBodyProps) {
  const { view, settings, log, switched = null, asking = false, onAsking = () => {}, phone, canEdit, now, act } = props
  const t = useT()
  const line = (
    <p className="wake-state" data-state={view.state}>
      {stateLine(view, t, now)}
    </p>
  )
  if (phone)
    return (
      <div className="sheet-body cats-body wake-body">
        {line}
        <p className="sheet-meta wake-read-only">{t('wake.readOnly')}</p>
      </div>
    )
  const off = !canEdit
  const buttons = wakeButtons(view)
  const offered = switchOffered(view)
  return (
    <div className="sheet-body cats-body wake-body">
      <div className="wake-row">
        <strong className="wake-label">{t('wake.switch')}</strong>
        <Switch name="wake" label={t('wake.switch')} on={view.on} disabled={off} onFlip={on => void act.turn(on)} />
      </div>
      {line}
      {(buttons.length > 0 || offered) && (
        <div className="wake-actions">
          {buttons.map(b => (
            <button
              type="button"
              key={b}
              className={b === 'log' ? 'button' : 'button primary'}
              disabled={off}
              onClick={() => void act[b]()}
            >
              {t(BUTTON[b])}
            </button>
          ))}
          {offered && (
            <button
              type="button"
              className="button primary wake-switch-over"
              disabled={off || asking}
              onClick={() => onAsking(true)}
            >
              {t('wake.switchOver')}
            </button>
          )}
        </div>
      )}
      {offered && asking && (
        <div className="profile-note wake-confirm">
          <p>{t('wake.switchConfirm')}</p>
          <div className="wake-actions">
            <button
              type="button"
              className="button primary wake-switch-go"
              disabled={off}
              onClick={() => {
                onAsking(false)
                void act.switchOver()
              }}
            >
              {t('wake.switchGo')}
            </button>
            <button type="button" className="button wake-cancel" onClick={() => onAsking(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
      {switched && <SwitchedNote switched={switched} />}
      {settings?.takenOver && !switched && (
        <TakenOverNote taken={settings.takenOver} disabled={off} onSeen={() => void act.seen()} />
      )}
      {log !== null && <pre className="wake-log">{log}</pre>}
      {hookNotes(view, settings).map(h => (
        <div className="profile-note wake-hooks" key={h.id} data-id={h.id}>
          <p>{t(h.state === 'old' ? 'wake.hooks.old' : 'wake.hooks.missing', { title: h.title })}</p>
          {h.state === 'missing' && (
            <button type="button" className="button primary" disabled={off} onClick={() => void act.install(h.id)}>
              {t('prof.install')}
            </button>
          )}
        </div>
      ))}
      {settings && <Reaper settings={settings} disabled={off} act={act} />}
      {settings && <Telegram settings={settings} router={routerLine(view, t)} disabled={off} act={act} />}
    </div>
  )
}

/** What Switch over… took over, the launcher it leaves as it is, and the key bindings to rename. */
function SwitchedNote({ switched }: { switched: Switched }) {
  const t = useT()
  const { taken, launcher, bindings } = switchedLines(switched, t)
  return (
    <div className="profile-note wake-switched">
      <p>{taken}</p>
      {launcher && <p>{launcher}</p>}
      {bindings && <p>{bindings}</p>}
    </div>
  )
}

/**
 * What the takeover at wake's first start did (nobody asked: the reaper and Telegram left off),
 * until it was seen: "Got it" says so to the board, which does not say it again.
 */
function TakenOverNote({ taken, disabled, onSeen }: { taken: Switched; disabled: boolean; onSeen(): void }) {
  const t = useT()
  const { taken: line, launcher, bindings } = takenOverLines(taken, t)
  return (
    <div className="profile-note wake-taken-over">
      <p>{line}</p>
      {launcher && <p>{launcher}</p>}
      {bindings && <p>{bindings}</p>}
      <div className="wake-actions">
        <button type="button" className="button wake-seen" disabled={disabled} onClick={onSeen}>
          {t('wake.takenOverSeen')}
        </button>
      </div>
    </div>
  )
}

interface SwitchProps {
  /** Which switch (`data-switch`). */
  name: string
  label: string
  on: boolean
  disabled: boolean
  onFlip(on: boolean): void
}

/** On or off, flipped by a press. */
function Switch({ name, label, on, disabled, onFlip }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="wake-switch"
      data-switch={name}
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onFlip(!on)}
    >
      <span className="wake-knob" aria-hidden="true" />
    </button>
  )
}

interface SectionProps {
  settings: WakeSettingsView
  disabled: boolean
  act: WakeActions
}

/**
 * Put idle sessions to sleep: on or off, after how many minutes, and the names never put to sleep.
 * A field is saved when it is left (Enter leaves the minutes), Escape puts the board's value back;
 * a refusal (toasted) shows the board's value again. A new value from the board draws it anew.
 */
function Reaper({ settings, disabled, act }: SectionProps) {
  const t = useT()
  const r = settings.reaper
  const names = r.exclude.join('\n')
  return (
    <div className="wake-section">
      <div className="wake-row">
        <div className="wake-label">
          <strong>{t('wake.reaper')}</strong>
          {r.enabled && (
            <span className="sheet-meta wake-reaper-after">{t('wake.reaper.after', { min: r.idleMinutes })}</span>
          )}
        </div>
        <Switch
          name="reaper"
          label={t('wake.reaper')}
          on={r.enabled}
          disabled={disabled}
          onFlip={enabled => void act.reaper({ enabled })}
        />
      </div>
      <label className="wake-field">
        <span>{t('wake.reaper.minutes')}</span>
        <input
          key={r.idleMinutes}
          className="path-add wake-minutes"
          inputMode="numeric"
          spellCheck={false}
          aria-label={t('wake.reaper.minutes')}
          defaultValue={r.idleMinutes}
          disabled={disabled}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.stopPropagation()
              e.currentTarget.value = String(r.idleMinutes)
              e.currentTarget.blur()
            }
          }}
          onBlur={e => {
            const field = e.currentTarget
            const next = minutesEdited(r.idleMinutes, field.value)
            if (next === null) {
              field.value = String(r.idleMinutes)
              return
            }
            void act.reaper({ idleMinutes: next }).then(ok => {
              if (!ok) field.value = String(r.idleMinutes)
            })
          }}
        />
      </label>
      <label className="wake-field wake-field-names">
        <span>{t('wake.reaper.exclude')}</span>
        <textarea
          key={names}
          className="path-add wake-exclude"
          rows={3}
          spellCheck={false}
          aria-label={t('wake.reaper.exclude')}
          placeholder={t('wake.reaper.excludeHint')}
          defaultValue={names}
          disabled={disabled}
          onKeyDown={e => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            e.currentTarget.value = names
            e.currentTarget.blur()
          }}
          onBlur={e => {
            const field = e.currentTarget
            const next = excludeEdited(r.exclude, field.value)
            if (next === null) return
            void act.reaper({ exclude: next }).then(ok => {
              if (!ok) field.value = names
            })
          }}
        />
      </label>
    </div>
  )
}

const MODES = ['auto', 'off'] as const

/** Telegram messages through tg-mcp: Auto or Off, what it found, and what its router does while wake runs. */
function Telegram({ settings, router, disabled, act }: SectionProps & { router: string | null }) {
  const t = useT()
  const line = telegramLine(settings, t)
  return (
    <div className="wake-section">
      <div className="wake-row">
        <div className="wake-label">
          <strong>{t('wake.telegram')}</strong>
          {line && <span className="sheet-meta wake-telegram-line">{line}</span>}
        </div>
        <span className="profile-shown wake-telegram-mode">
          {MODES.map(mode => (
            <button
              type="button"
              key={mode}
              aria-pressed={settings.telegram === mode}
              disabled={disabled}
              onClick={() => {
                if (settings.telegram !== mode) void act.telegram(mode)
              }}
            >
              {t(`wake.telegram.${mode}`)}
            </button>
          ))}
        </span>
      </div>
      {router && <p className="sheet-meta wake-router">{router}</p>}
      {settings.telegram === 'auto' && settings.found && (
        <button type="button" className="button wake-launcher" disabled={disabled} onClick={() => void act.launcher()}>
          {t('wake.launcher')}
        </button>
      )}
    </div>
  )
}
