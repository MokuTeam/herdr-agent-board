// Settings → Sleep and wake… (#119), its rules on their own: wake's state in one line, in the
// board's words and time format; when the toolbar's quiet "Wake stopped" note shows; the buttons
// each state offers; Telegram's line and its router's while wake runs; what Switch over… took over;
// what an edit of the reaper's fields sends; and the switches shown as sent until the board says the
// same (its config watcher reads config.json a moment later). The payload's `wake`, GET /api/wake's
// answer and Switch over's are read through their guards.
import type { Translator } from '../../../src/core/types.ts'
import type { ReaperConfig, TelegramMode } from '../../../src/core/wake/config.ts'
import type { WakeState } from '../../../src/core/wake/status.ts'
import type { Switched, WakeSettingsView, WakeView } from '../../../src/core/wake/view.ts'
import { shortWhen } from '../../../src/core/when-format.ts'

/** How long wake is on but not running before the toolbar says so. */
export const NOTE_AFTER_MS = 60_000

const STATES: Record<WakeState, true> = {
  off: true,
  starting: true,
  running: true,
  crashed: true,
  notRunning: true,
  held: true,
  portTaken: true,
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === 'number'
const ROUTER_STATES: ReadonlySet<unknown> = new Set(['off', 'polling', 'error'])

/** The payload's `wake` (src/core/wake/view.ts WakeView), as far as the page relies on it. */
export const isWakeView = (v: unknown): v is WakeView =>
  isRecord(v) &&
  typeof v.on === 'boolean' &&
  typeof v.state === 'string' &&
  Object.hasOwn(STATES, v.state) &&
  isNumberOrNull(v.since) &&
  typeof v.asleep === 'number' &&
  typeof v.port === 'number' &&
  (v.error === undefined || typeof v.error === 'string') &&
  (v.crashes === undefined || typeof v.crashes === 'number') &&
  (v.downSince === undefined || isNumberOrNull(v.downSince)) &&
  (v.telegram === undefined || (isRecord(v.telegram) && ROUTER_STATES.has(v.telegram.state)))

const isPair = (v: unknown): v is { old: string; now: string } =>
  isRecord(v) && typeof v.old === 'string' && typeof v.now === 'string'

/** POST /api/wake { op: 'switch' }'s answer once it went through (src/core/wake/view.ts Switched). */
export const isSwitched = (v: unknown): v is Switched =>
  isRecord(v) &&
  Array.isArray(v.did) &&
  v.did.every(line => typeof line === 'string') &&
  isRecord(v.summary) &&
  (v.summary.reaper === 'on' || v.summary.reaper === 'off') &&
  typeof v.summary.minutes === 'number' &&
  typeof v.summary.excluded === 'number' &&
  typeof v.summary.telegram === 'boolean' &&
  typeof v.summary.asleep === 'number' &&
  (v.launcher === null || isPair(v.launcher)) &&
  Array.isArray(v.bindings) &&
  v.bindings.every(b => isRecord(b) && typeof b.key === 'string' && isPair(b))

const isSettings = (v: unknown): v is WakeSettingsView =>
  isRecord(v) &&
  isRecord(v.reaper) &&
  typeof v.reaper.enabled === 'boolean' &&
  typeof v.reaper.idleMinutes === 'number' &&
  Array.isArray(v.reaper.exclude) &&
  v.reaper.exclude.every(s => typeof s === 'string') &&
  (v.telegram === 'auto' || v.telegram === 'off') &&
  (v.found === null || (isRecord(v.found) && typeof v.found.host === 'string')) &&
  (v.lastError === null || typeof v.lastError === 'string') &&
  typeof v.log === 'string' &&
  Array.isArray(v.hooks) &&
  v.hooks.every(
    h =>
      isRecord(h) &&
      typeof h.id === 'string' &&
      typeof h.title === 'string' &&
      (h.state === 'in' || h.state === 'old' || h.state === 'missing'),
  )

export interface WakeReply {
  view: WakeView
  settings: WakeSettingsView
}

/** GET /api/wake's answer (src/server/routes/wake.ts). */
export const isWakeReply = (v: unknown): v is WakeReply => isRecord(v) && isWakeView(v.view) && isSettings(v.settings)

const firstLine = (text: string): string => text.split(/\r?\n/)[0] ?? ''

/** Wake's state in one line: "Running since 9:12, 4 asleep", "Off. 3 asleep still wake from their cards", … */
export function stateLine(view: WakeView, t: Translator, now: number): string {
  switch (view.state) {
    case 'off':
      return view.asleep > 0 ? t('wake.state.offAsleep', { n: view.asleep }) : t('wake.state.off')
    case 'running':
      return t('wake.state.running', { time: shortWhen(view.since ?? now, t, now), n: view.asleep })
    case 'crashed':
      return t('wake.state.crashed', { n: view.crashes ?? 0, error: firstLine(view.error ?? '') }).trim()
    case 'portTaken':
      return t('wake.state.portTaken', { port: view.port })
    default:
      return t(`wake.state.${view.state}`)
  }
}

// On, but not running: what the toolbar's note waits a minute on.
const DOWN: ReadonlySet<WakeView['state']> = new Set(['crashed', 'notRunning', 'portTaken', 'starting'])

/** The toolbar's "Wake stopped": wake on, not running (nor off or held) for more than a minute, by `downSince`. */
export function noteShown(view: WakeView | undefined, now: number): boolean {
  if (!view?.on || !DOWN.has(view.state)) return false
  const since = view.downSince
  return typeof since === 'number' && now - since > NOTE_AFTER_MS
}

export type WakeButton = 'start' | 'again' | 'log'

/** The buttons under the state line: Start when not running; Start again and Log once crashed. */
export function wakeButtons(view: WakeView): WakeButton[] {
  if (view.state === 'notRunning') return ['start']
  if (view.state === 'crashed') return ['again', 'log']
  return []
}

/** "Switch over…" is offered while the separate herdr-wake plugin holds wake. */
export const switchOffered = (view: WakeView): boolean => view.state === 'held'

/**
 * What Switch over… took over, in the board's words: "reaper on, 60 min, 2 excluded; Telegram;
 * 4 sleeping sessions"; the launcher note (call 25) and the key bindings to rename (call 26), when
 * there are any.
 */
export function switchedLines(
  s: Switched,
  t: Translator,
): { taken: string; launcher: string | null; bindings: string | null } {
  const { reaper, minutes, excluded, telegram, asleep } = s.summary
  const parts = [
    reaper === 'on'
      ? [
          t('wake.summary.reaperOn', { min: minutes }),
          ...(excluded > 0 ? [t('wake.summary.excluded', { n: excluded })] : []),
        ].join(', ')
      : t('wake.summary.reaperOff'),
    ...(telegram ? [t('wake.summary.telegram')] : []),
    t('wake.summary.asleep', { n: asleep }),
  ]
  const list = s.bindings.map(b => `${b.key ? `${b.key} ` : ''}${b.old} → ${b.now}`).join(', ')
  return {
    taken: t('wake.switched', { summary: parts.join('; ') }),
    launcher: s.launcher ? t('wake.launcherNote', { old: s.launcher.old, now: s.launcher.now }) : null,
    bindings: list ? t('wake.bindings', { list }) : null,
  }
}

/**
 * The Telegram router's state while wake runs: receiving from tg-mcp's host, its last poll's
 * error, or not receiving; nothing while wake does not run (the status file keeps the last state
 * after a crash) or has none to say.
 */
export function routerLine(view: WakeView, t: Translator): string | null {
  const r = view.telegram
  if (view.state !== 'running' || !r) return null
  if (r.state === 'polling') return t('wake.router.polling', { host: r.host ?? '' })
  if (r.state === 'error') return t('wake.router.error', { error: firstLine(r.error ?? '') })
  return t('wake.router.off')
}

/** Under Telegram's Auto / Off: the last poll's error, the host it found, or that there is none; off and found: nothing. */
export function telegramLine(s: WakeSettingsView, t: Translator): string | null {
  if (s.telegram === 'off') return s.found ? null : t('wake.telegram.none')
  if (s.lastError) return t('wake.telegram.error', { error: firstLine(s.lastError) })
  return s.found ? t('wake.telegram.connected', { host: s.found.host }) : t('wake.telegram.none')
}

/** The shown profiles whose wake hooks the panel names: lacking or the old plugin's, while wake is on and not held. */
export function hookNotes(view: WakeView, settings: WakeSettingsView | null): WakeSettingsView['hooks'] {
  if (!settings || !view.on || view.state === 'held') return []
  return settings.hooks.filter(h => h.state !== 'in')
}

/** Minutes idle as typed: the number to send, null when it is the board's (or blank); what is no number goes as typed, for the board to say why not. */
export function minutesEdited(board: number, typed: string): number | string | null {
  const text = typed.trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isFinite(n)) return text
  return n === board ? null : n
}

/** The names never put to sleep as typed, one per line: the list to send, null when it is the board's. */
export function excludeEdited(board: string[], typed: string): string[] | null {
  const list = typed
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
  return JSON.stringify(list) === JSON.stringify(board) ? null : list
}

/** What the panel sent and the board does not say yet: the main switch, the reaper's fields, Telegram's mode. */
export interface WakePending {
  on?: boolean
  reaper?: Partial<Pick<ReaperConfig, 'enabled' | 'idleMinutes' | 'exclude'>>
  telegram?: TelegramMode
}

/** The view and settings with what was sent over them. */
export function withPending(
  view: WakeView | undefined,
  settings: WakeSettingsView | null,
  pending: WakePending,
): { view: WakeView | undefined; settings: WakeSettingsView | null } {
  return {
    view: view && pending.on !== undefined ? { ...view, on: pending.on } : view,
    settings: settings && {
      ...settings,
      reaper: { ...settings.reaper, ...pending.reaper },
      telegram: pending.telegram ?? settings.telegram,
    },
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What was sent and the board does not say yet: each part the board now says the same of is dropped. */
export function settledPending(
  view: WakeView | undefined,
  settings: WakeSettingsView | null,
  pending: WakePending,
): WakePending {
  const left: WakePending = {}
  if (pending.on !== undefined && view?.on !== pending.on) left.on = pending.on
  if (pending.telegram !== undefined && settings?.telegram !== pending.telegram) left.telegram = pending.telegram
  const reaper = Object.fromEntries(
    Object.entries(pending.reaper ?? {}).filter(
      ([k, v]) => !settings || !same(settings.reaper[k as keyof ReaperConfig], v),
    ),
  )
  if (Object.keys(reaper).length) left.reaper = reaper
  return left
}
