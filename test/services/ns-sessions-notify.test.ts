// NetSuite session notification service & prefs persistence (#897): fires once per session
// lifetime on dying/dead, delivers to desk toast + day session, leaves zero timers when empty,
// and never exposes cookie values.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNsNotifyPrefs, updateNsNotifyPrefs } from '../../src/adapters/ns-sessions-prefs.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { createNsStore, NS_DYING_MS, NS_IDLE_MS, nsFingerprint, nsPublishOf } from '../../src/core/ns-sessions.ts'
import { NO_NS_NOTIFY_PREFS, setAccountNotify } from '../../src/core/ns-sessions-notify.ts'
import type { Item } from '../../src/core/types.ts'
import type { NoticeToast } from '../../src/integrations/notice-toast.ts'
import { createNsSessionsNotify } from '../../src/services/ns-sessions-notify.ts'

const SECRET = 'fake-notify-jsessionid-91b2'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'ns-prefs-'))
  dirs.push(d)
  return join(d, 'ns-sessions-prefs.json')
}

describe('ns-sessions prefs & notify service', () => {
  test('prefs file is absent until written, persists toggles and validates keys', () => {
    const file = tempFile()
    expect(existsSync(file)).toBe(false)
    expect(readNsNotifyPrefs(file)).toEqual(NO_NS_NOTIFY_PREFS)
    expect(existsSync(file)).toBe(false)

    const updated = updateNsNotifyPrefs(p => setAccountNotify(p, '1234567_SB1', true), file)
    expect(updated).toEqual({ accounts: { '1234567_SB1': true } })
    expect(readNsNotifyPrefs(file)).toEqual({ accounts: { '1234567_SB1': true } })
  })

  test('fires once per death via desk toast + day session; no cookie values in notices or logs', async () => {
    let t = Date.UTC(2026, 10, 26, 17, 0, 0)
    const store = createNsStore({ now: () => t })
    const toasts: NoticeToast[] = []
    const dayDeliveries: { key: string; body: string }[] = []
    const logs: string[] = []
    const dayItem = { key: 'day-1', name: 'Day Master', day: true } as unknown as Item

    const svc = createNsSessionsNotify({
      store,
      prefs: () => NO_NS_NOTIFY_PREFS,
      desktop: { show: toast => toasts.push(toast) },
      items: () => [dayItem],
      deliverToDay: (day, body) => dayDeliveries.push({ key: day.key, body }),
      log: line => logs.push(line),
      now: () => t,
      zone: () => 'UTC',
      t: translator('en'),
    })

    try {
      expect(store.nextTransitionAt(t)).toBeNull()
      store.publish(
        nsPublishOf({
          account: '1234567',
          user: 'agent@example.com',
          host: '1234567.app.netsuite.com',
          role: null,
          role_id: null,
          fp: nsFingerprint(SECRET),
          cookies: [
            {
              name: 'JSESSIONID',
              value: SECRET,
              domain: '1234567.app.netsuite.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax',
            },
          ],
          origin: { machine: 'laptop', profile: 'work' },
          login_at: t,
          seen_at: t,
          auto_renew: false,
        }),
      )
      expect(toasts).toEqual([])
      expect(dayDeliveries).toEqual([])

      // Advance to dying threshold (3h - 20m = 2h40 -> 19:40 UTC): check() fires once.
      t += NS_IDLE_MS - NS_DYING_MS
      svc.check()
      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.title).toBe('NetSuite · 1234567')
      expect(toasts[0]?.body).toBe('1234567 ends at 20:00; log in when convenient, the login will be shared')
      expect(dayDeliveries).toEqual([{ key: 'day-1', body: toasts[0]?.body ?? '' }])

      // Explicit death of the same fp does NOT fire a second notice.
      store.dead('1234567', nsFingerprint(SECRET), 'logout', { machine: 'laptop', profile: 'work' })
      expect(toasts).toHaveLength(1)
      expect(dayDeliveries).toHaveLength(1)

      for (const s of [...logs, JSON.stringify(toasts), JSON.stringify(dayDeliveries)]) {
        expect(s).not.toContain(SECRET)
      }
    } finally {
      svc.stop()
    }
  })
})
