// NetSuite session death & expiry notices (#897, core/ns-sessions-notify.ts):
// notifies the owner once per session lifetime when an account without auto-renew (or marked
// notify) turns dying or dead, via desktop toast and the board's day session (which MokuPilot /
// Telegram router relays when configured). Never carries a cookie value; arms zero timers when
// the store has no live/dying entries.
import { addEntry } from '../adapters/schedule-store.ts'
import { t as boardT } from '../core/lang.ts'
import { parseNodeKey } from '../core/nodes.ts'
import type { NsStore } from '../core/ns-sessions.ts'
import { type NsNotifyPrefs, planNsNotices } from '../core/ns-sessions-notify.ts'
import { localZone } from '../core/time.ts'
import type { Item, Translator } from '../core/types.ts'
import type { NoticeDesktop } from '../integrations/notice-toast.ts'

const MAX_WAIT_MS = 60_000
const MAX_NOTIFIED = 1000

export interface NsSessionsNotifyOptions {
  store: NsStore
  prefs(): NsNotifyPrefs
  desktop: NoticeDesktop
  items(): readonly Item[]
  deliverToDay?: (day: Item, body: string, now: number) => void
  log(line: string): void
  now?: () => number
  zone?: () => string
  t?: Translator
}

export interface NsSessionsNotify {
  check(): void
  stop(): void
}

export function createNsSessionsNotify(o: NsSessionsNotifyOptions): NsSessionsNotify {
  const now = o.now ?? Date.now
  const zone = o.zone ?? localZone
  const t = o.t ?? boardT
  const deliverToDay =
    o.deliverToDay ??
    ((day, text, at) => {
      const local = !parseNodeKey(day.key)
      addEntry({
        key: day.key,
        name: day.name || day.autoName || day.key.slice(0, 8),
        ...(local && day.pane && { pane: day.pane }),
        ...(local && day.cwd && { cwd: day.cwd }),
        text,
        at,
        next: at,
        by: 'ns-sessions',
      })
    })

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let checking = false
  const notified = new Set<string>()

  function arm(): void {
    clearTimeout(timer)
    timer = undefined
    if (stopped) return
    const next = o.store.nextTransitionAt(now())
    if (next === null) return
    const wait = Math.min(Math.max(50, next - now()), MAX_WAIT_MS)
    timer = setTimeout(() => check(), wait)
    timer.unref?.()
  }

  function check(): void {
    if (stopped || checking) return
    checking = true
    try {
      const entries = o.store.list()
      const { notices, activeKeys } = planNsNotices(entries, o.prefs(), notified, zone(), t)
      for (const k of [...notified]) {
        if (!activeKeys.has(k)) notified.delete(k)
      }
      if (notices.length > 0) {
        const at = now()
        const day = o.items().find(i => i.day && !i.lostAccess)
        for (const n of notices) {
          notified.add(n.key)
          while (notified.size > MAX_NOTIFIED) {
            const first = notified.values().next().value
            if (first === undefined) break
            notified.delete(first)
          }
          try {
            o.desktop.show({ id: n.id, title: n.title, body: n.body })
          } catch (err) {
            o.log(`ns-sessions notice: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (day) {
            try {
              deliverToDay(day, n.body, at)
            } catch (err) {
              o.log(`ns-sessions notice (day): ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          o.log(`ns-sessions: notice ${n.account} (${n.state})`)
        }
      }
    } finally {
      checking = false
      arm()
    }
  }

  const unsub = o.store.subscribe(() => check())
  arm()

  return {
    check,
    stop() {
      stopped = true
      clearTimeout(timer)
      timer = undefined
      unsub()
    },
  }
}
