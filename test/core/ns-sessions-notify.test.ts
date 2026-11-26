// NetSuite per-account notify preferences and once-per-death notice planning (#897,
// core/ns-sessions-notify.ts): defaults, overrides, deduplication across dying -> dead,
// message formatting, and zero cookie values.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { NsMeta } from '../../src/core/ns-sessions.ts'
import {
  formatNsNotice,
  isNsNotifyPrefs,
  NO_NS_NOTIFY_PREFS,
  planNsNotices,
  setAccountNotify,
  shouldNotifyAccount,
} from '../../src/core/ns-sessions-notify.ts'

const T = Date.UTC(2026, 10, 26, 18, 0, 0)
const tEn = translator('en')

function meta(overrides: Partial<NsMeta> = {}): NsMeta {
  return {
    account: '1234567',
    user: 'agent@example.com',
    host: '1234567.app.netsuite.com',
    role: 'Administrator',
    fp: '0a1b2c3d',
    state: 'live',
    generation: 1,
    login_at: T - 10 * 3_600_000,
    first_seen: T - 10 * 3_600_000,
    abs_expiry: T + 2 * 3_600_000 + 5 * 60_000,
    abs_expiry_estimated: false,
    idle_expiry: T + 3 * 3_600_000,
    last_activity: T,
    last_where: { machine: 'laptop', profile: 'work' },
    origin: { machine: 'laptop', profile: 'work' },
    holders: ['laptop'],
    dead_at: null,
    dead_reason: null,
    auto_renew: false,
    last_event: null,
    lock: null,
    ...overrides,
  }
}

describe('ns-sessions notify prefs & planning', () => {
  test('shouldNotifyAccount defaults ON for auto_renew=false, OFF for true/null, overridden by explicit pref', () => {
    expect(shouldNotifyAccount('1234567', false, NO_NS_NOTIFY_PREFS)).toBe(true)
    expect(shouldNotifyAccount('1234567', true, NO_NS_NOTIFY_PREFS)).toBe(false)
    expect(shouldNotifyAccount('1234567', null, NO_NS_NOTIFY_PREFS)).toBe(false)

    const p1 = setAccountNotify(NO_NS_NOTIFY_PREFS, '1234567', false)
    expect(shouldNotifyAccount('1234567', false, p1)).toBe(false)

    const p2 = setAccountNotify(p1, '7654321_SB1', true)
    expect(shouldNotifyAccount('7654321_SB1', true, p2)).toBe(true)

    const p3 = setAccountNotify(p2, '1234567', null)
    expect(shouldNotifyAccount('1234567', false, p3)).toBe(true)
    expect(isNsNotifyPrefs(p2)).toBe(true)
    expect(isNsNotifyPrefs({ accounts: { 'bad-account': true } })).toBe(false)
    expect(isNsNotifyPrefs({ accounts: { '1234567': 'yes' } })).toBe(false)
  })

  test('formatNsNotice names the account and exact end time in UTC', () => {
    const ends = Date.UTC(2026, 10, 26, 20, 5, 0)
    const dying = formatNsNotice(meta({ state: 'dying', abs_expiry: ends, idle_expiry: ends + 3_600_000 }), 'UTC', tEn)
    expect(dying.title).toBe('NetSuite · 1234567')
    expect(dying.body).toBe('1234567 ends at 20:05; log in when convenient, the login will be shared')

    const dyingEstimated = formatNsNotice(
      meta({
        state: 'dying',
        login_at: null,
        abs_expiry: ends,
        abs_expiry_estimated: true,
        idle_expiry: ends + 3_600_000,
      }),
      'UTC',
      tEn,
    )
    expect(dyingEstimated.body).toBe('1234567 ends about 20:05; log in when convenient, the login will be shared')

    const dead = formatNsNotice(meta({ state: 'dead', dead_at: ends }), 'UTC', tEn)
    expect(dead.body).toBe('1234567 session ended at 20:05; log in when convenient, the login will be shared')
  })

  test('planNsNotices fires once per death across dying -> dead and again for a new fp', () => {
    const notified = new Set<string>()
    const dyingEntry = meta({ state: 'dying' })
    const autoRenewEntry = meta({
      account: '9876543',
      host: '9876543.app.netsuite.com',
      auto_renew: true,
      state: 'dead',
      dead_at: T,
    })

    const r1 = planNsNotices([dyingEntry, autoRenewEntry], NO_NS_NOTIFY_PREFS, notified, 'UTC', tEn)
    expect(r1.notices).toHaveLength(1)
    expect(r1.notices[0]?.account).toBe('1234567')
    expect(r1.notices[0]?.state).toBe('dying')
    for (const n of r1.notices) notified.add(n.key)

    // Activity moves the same fp back from dying to live, then dying again -> keeps key, NO repeat notice.
    const liveSameFp = meta({ state: 'live' })
    const rLive = planNsNotices([liveSameFp, autoRenewEntry], NO_NS_NOTIFY_PREFS, notified, 'UTC', tEn)
    expect(rLive.notices).toEqual([])
    expect(rLive.activeKeys.has(r1.notices[0]?.key ?? '')).toBe(true)

    const dyingAgain = planNsNotices([dyingEntry, autoRenewEntry], NO_NS_NOTIFY_PREFS, notified, 'UTC', tEn)
    expect(dyingAgain.notices).toEqual([])

    // Same fp transitions to dead -> does NOT fire again.
    const deadSameFp = meta({ state: 'dead', dead_at: T + 60_000 })
    const r2 = planNsNotices([deadSameFp, autoRenewEntry], NO_NS_NOTIFY_PREFS, notified, 'UTC', tEn)
    expect(r2.notices).toEqual([])
    expect(r2.activeKeys.has(r1.notices[0]?.key ?? '')).toBe(true)

    // New login (new fp) dies later -> fires once for the new fp.
    const deadNewFp = meta({ fp: '11223344', state: 'dead', dead_at: T + 120_000 })
    const r3 = planNsNotices([deadNewFp], NO_NS_NOTIFY_PREFS, notified, 'UTC', tEn)
    expect(r3.notices).toHaveLength(1)
    expect(r3.notices[0]?.state).toBe('dead')
  })
})
