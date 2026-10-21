// Settings → Sleep and wake…'s side of the page (#119): its settings as GET /api/wake has them,
// asked when the panel opens and again when wake's line in the payload changes or while something
// it sent is not said back yet; what its controls send (POST /api/wake, and Install into a profile
// through POST /api/profiles), refusals toasted; the switches shown as sent until the board says
// the same; the log once asked for. Nothing is asked on a phone: those routes are the computer's.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import type { TelegramMode } from '../../../src/core/wake/config.ts'
import type { WakeSettingsView } from '../../../src/core/wake/view.ts'
import { api, errorText, type Reply } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { isWakeReply, isWakeView, settledPending, type WakePending } from '../models/wake.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

/** The reaper's fields as the panel sends them; minutes that are no number go as typed, for the board to say why not. */
export interface ReaperEdit {
  enabled?: boolean
  idleMinutes?: number | string
  exclude?: string[]
}

/** What the panel's controls do; each resolves whether the board took it (a refusal is toasted). */
export interface WakeActions {
  turn(on: boolean): Promise<boolean>
  reaper(fields: ReaperEdit): Promise<boolean>
  telegram(mode: TelegramMode): Promise<boolean>
  start(): Promise<boolean>
  again(): Promise<boolean>
  /** wake.log's last lines, shown under the buttons. */
  log(): Promise<boolean>
  /** Wake's hooks (with the board's) into a shown profile, as the Profiles panel's Install. */
  install(id: string): Promise<boolean>
}

export interface WakeActionDeps {
  post(path: string, body: unknown): Promise<Reply>
  t(): Translator
  canEdit(): boolean
  toast(text: string, error?: boolean): void
  /** What a switch sent, shown until the board says the same. */
  sent(pending: WakePending): void
  /** GET /api/wake again (a profile's hooks changed). */
  reload(): void
  showLog(text: string): void
}

/** What was sent of the reaper, as it will read back: minutes that are no number are the board's to refuse. */
function reaperSent(fields: ReaperEdit): WakePending {
  const { enabled, idleMinutes, exclude } = fields
  return {
    reaper: {
      ...(enabled !== undefined && { enabled }),
      ...(typeof idleMinutes === 'number' && { idleMinutes }),
      ...(exclude && { exclude }),
    },
  }
}

export function wakeActions(deps: WakeActionDeps): WakeActions {
  /** The board's answer, or null when it was not asked (no board) or said no (toasted). */
  async function ask(path: string, body: Record<string, unknown>): Promise<Reply | null> {
    if (!deps.canEdit()) {
      deps.toast(deps.t()('live.off'), true)
      return null
    }
    try {
      return await deps.post(path, body)
    } catch (err) {
      deps.toast(errorText(err, deps.t()), true)
      return null
    }
  }
  const op = async (body: Record<string, unknown>, pending?: WakePending): Promise<boolean> => {
    if (!(await ask('/api/wake', body))) return false
    if (pending) deps.sent(pending)
    return true
  }
  return {
    turn: on => op({ op: on ? 'on' : 'off' }, { on }),
    reaper: fields => op({ op: 'reaper', ...fields }, reaperSent(fields)),
    telegram: mode => op({ op: 'telegram', mode }, { telegram: mode }),
    start: () => op({ op: 'start' }),
    again: () => op({ op: 'again' }),
    async log() {
      const reply = await ask('/api/wake', { op: 'log' })
      if (!reply) return false
      deps.showLog(typeof reply.text === 'string' ? reply.text : '')
      return true
    },
    async install(id) {
      if (!(await ask('/api/profiles', { op: 'install', id }))) return false
      deps.reload()
      return true
    },
  }
}

/** Two sendings in one: the later one's parts over the earlier one's. */
const addPending = (was: WakePending, more: WakePending): WakePending => ({
  ...was,
  ...more,
  ...((was.reaper || more.reaper) && { reaper: { ...was.reaper, ...more.reaper } }),
})

export interface WakePanelState {
  /** GET /api/wake's settings; null until it answered (and on a phone). */
  settings: WakeSettingsView | null
  pending: WakePending
  /** wake.log's last lines, once Log was pressed. */
  log: string | null
  act: WakeActions
}

/** The panel's state while `active` (open, on this computer); closed, it forgets what it held. */
export function useWake(active: boolean): WakePanelState {
  const t = useT()
  const { data, canEdit, toast } = useBoardContext()
  const [settings, setSettings] = useState<WakeSettingsView | null>(null)
  const [pending, setPending] = useState<WakePending>({})
  const [log, setLog] = useState<string | null>(null)
  const latest = useLatest({ t, canEdit, toast, active })
  const asked = useRef(0)
  const view = isWakeView(data?.wake) ? data.wake : undefined

  // Only the newest answer counts; one that comes after the panel closed is dropped.
  const load = useCallback(async () => {
    const mine = ++asked.current
    try {
      const reply = await api.get('/api/wake', isWakeReply, { cache: 'no-store' })
      if (mine === asked.current && latest.current.active) setSettings(reply.settings)
    } catch {
      // The panel keeps what it has; the board's next change asks again.
    }
  }, [latest])

  const [act] = useState(() =>
    wakeActions({
      post: (path, body) => api.post(path, body),
      t: () => latest.current.t,
      canEdit: () => latest.current.canEdit,
      toast: (text, error) => latest.current.toast(text, error),
      sent: more => setPending(was => addPending(was, more)),
      reload: () => void load(),
      showLog: setLog,
    }),
  )

  // Asked when it opens, and again when wake's line changes; while something sent is not said
  // back yet, at each board that comes (the config watcher reads config.json a moment later).
  const viewKey = JSON.stringify(view ?? null)
  const waiting = Object.keys(pending).length > 0
  const asks = waiting ? data : viewKey
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asks` is when to ask again
  useEffect(() => {
    if (active) void load()
  }, [active, asks, load])

  useEffect(() => {
    if (active) return
    asked.current++
    setSettings(null)
    setPending({})
    setLog(null)
  }, [active])

  // What the board says the same of now is no longer held as sent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line or new settings are when to compare
  useEffect(() => {
    setPending(was => {
      const left = settledPending(view, settings, was)
      return JSON.stringify(left) === JSON.stringify(was) ? was : left
    })
  }, [viewKey, settings])

  return { settings, pending, log, act }
}
