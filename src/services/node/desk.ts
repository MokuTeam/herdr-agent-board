// The node's side of the owner's desk (#788, core/desk.ts). Made by server/app.ts only once
// config.json has `node`; nothing here runs on its own: the master asks.
// - GET /api/node/desk: this computer's idle time and lock (adapters/idle.ts) while it has a
//   desktop; a computer without one says so and reads nothing.
// - POST /api/node/desk-toast: a calendar reminder or a Team message the master sends because the
//   owner is at this computer, shown with this computer's own notifier (Windows or macOS toast,
//   herdr's notification elsewhere). A reminder's buttons and a message's click come back to this
//   board, which passes them up to the master (core/master-relay.ts, the calendar and team groups).
import { notify } from '../../adapters/herdr.ts'
import { type DeskAnswer, deskToastOf } from '../../core/desk.ts'
import type { Observation } from '../../core/presence.ts'
import type { NoticeDesktop } from '../../integrations/notice-toast.ts'
import type { ReminderDesktop } from '../../integrations/reminder-toast.ts'
import type { TeamDesktop } from '../../integrations/team-toast.ts'
import type { Answer } from './bundle.ts'

export interface NodeDesk {
  /** The master's ask: this computer's desk now. */
  answer(): Promise<DeskAnswer>
  /** The master's notification, shown here. */
  toast(raw: unknown): Answer
}

export interface NodeDeskDeps {
  desktop(): boolean
  observe(): Promise<Observation>
  /** This computer's notifiers, made when first used. */
  reminder(): ReminderDesktop
  team(): TeamDesktop
  notice?: () => NoticeDesktop
}

export function createNodeDesk(d: NodeDeskDeps): NodeDesk {
  return {
    async answer() {
      if (!d.desktop()) return { ok: true, desktop: false }
      try {
        const obs = await d.observe()
        return { ok: true, desktop: true, idleSec: obs.idleSec, locked: obs.locked }
      } catch {
        return { ok: true, desktop: true, idleSec: null, locked: null }
      }
    },
    toast(raw) {
      const t = deskToastOf(raw)
      if (!t) return { status: 400, body: { ok: false, error: 'toast' } }
      if (t.kind === 'reminder') d.reminder().show(t.toast)
      else if (t.kind === 'reminder-clear') d.reminder().clear(t.id)
      else if (t.kind === 'team') d.team().show(t.toast)
      else if (d.notice) d.notice().show(t.toast)
      else void notify(t.toast.title, t.toast.body).catch(() => {})
      return { status: 200, body: { ok: true } }
    },
  }
}
