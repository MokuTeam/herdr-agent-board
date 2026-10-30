// The board's presence service (#172) against a fake computer and clock: auto and suggest
// detection, the manual switch winning until the next clear change, the board's own page counting
// as input, and presence turned on and off under a running board. Nothing reaches a session but
// the mark on its card.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { currentPresence, presenceFile, readPresence } from '../../src/adapters/presence-store.ts'
import { type MokupilotCall, NO_PRESENCE, type Observation } from '../../src/core/presence.ts'
import type { Config } from '../../src/core/types.ts'
import { createPresence } from '../../src/services/presence.ts'
import { isolatedHome } from '../support/env.ts'

function rig(presence: Config['presence'], mokupilot?: unknown) {
  const cfg: Pick<Config, 'presence'> & { mokupilot?: unknown } = { presence, mokupilot }
  let obs: Observation = { idleSec: null, locked: null }
  let clock = 1_000
  let changes = 0
  const logs: string[] = []
  let asked = 0
  // MokuPilot (#276): whether it has run here, and its call in progress; each look counted.
  let here = false
  let call: MokupilotCall | null | undefined = null
  const looks = { here: 0, call: 0 }
  const svc = createPresence({
    cfg,
    log: l => logs.push(l),
    onChange: () => changes++,
    sessions: () => ['s1', 's2'],
    observe: async () => {
      asked++
      return obs
    },
    call: () => {
      looks.call++
      return call
    },
    callsHere: () => {
      looks.here++
      return here
    },
    now: () => clock,
  })
  return {
    svc,
    cfg,
    logs,
    see(o: Partial<Observation>) {
      obs = { idleSec: null, locked: null, ...o }
    },
    later(ms: number) {
      clock += ms
    },
    mokupilot(on: boolean, id: string | null = null, started = 0) {
      here = on
      call = id === null ? null : { id, started }
    },
    /** call.json there but held by another program: no answer. */
    unreadable() {
      call = undefined
    },
    looks,
    get changes() {
      return changes
    },
    get asked() {
      return asked
    },
  }
}

test('off: no view, nothing asked, nothing written', async () => {
  isolatedHome()
  const r = rig(undefined)
  r.see({ idleSec: 99999 })
  await r.svc.tick()
  r.svc.touch()
  expect(r.svc.view()).toBeNull()
  expect(r.asked).toBe(0)
  expect(r.changes).toBe(0)
  expect(existsSync(presenceFile())).toBe(false)
})

test('auto: away when idle past the minutes or locked, here on input', async () => {
  isolatedHome()
  const r = rig({ mode: 'auto', idleMinutes: 10 })
  r.see({ idleSec: 60 })
  await r.svc.tick()
  expect(r.svc.view()).toMatchObject({ state: 'here', mode: 'auto', idleMinutes: 10, hint: null, detects: true })
  r.later(600_000)
  r.see({ idleSec: 660 })
  await r.svc.tick()
  expect(readPresence()).toEqual({ state: 'away', since: 601_000, by: 'auto', from: 'auto' })
  expect(r.logs).toContain('presence: away (detected)')
  r.see({ idleSec: 2 })
  await r.svc.tick()
  expect(currentPresence().state).toBe('here')
  r.see({ locked: true })
  await r.svc.tick()
  expect(currentPresence().state).toBe('away')
  // An unlocked screen is back.
  r.see({ locked: false })
  await r.svc.tick()
  expect(currentPresence().state).toBe('here')
})

test('a computer that tells nothing leaves the state alone and says so', async () => {
  isolatedHome()
  const r = rig(true)
  await r.svc.tick()
  expect(r.svc.view()).toMatchObject({ state: 'here', detects: false })
  expect(existsSync(presenceFile())).toBe(false)
})

test('suggest: offers the switch, a switch answers the offer', async () => {
  isolatedHome()
  const r = rig({ mode: 'suggest', idleMinutes: 5 })
  r.see({ idleSec: 600 })
  await r.svc.tick()
  expect(r.svc.view()).toMatchObject({ state: 'here', hint: 'away' })
  expect(existsSync(presenceFile())).toBe(false)
  r.svc.set('away', 'web')
  expect(r.svc.view()).toMatchObject({ state: 'away', by: 'user', from: 'web', hint: null })
})

test('manual wins until the next clear change', async () => {
  isolatedHome()
  const r = rig({ mode: 'auto', idleMinutes: 10 })
  r.see({ idleSec: 1 })
  await r.svc.tick()
  // "Away" clicked at the keyboard: the input right after does not undo it.
  expect(r.svc.set('away', 'web').changed).toBe(true)
  await r.svc.tick()
  r.svc.touch()
  expect(currentPresence()).toMatchObject({ state: 'away', by: 'user' })
  // The user leaves (detection agrees), comes back: here again.
  r.see({ idleSec: 900 })
  await r.svc.tick()
  expect(currentPresence().state).toBe('away')
  r.see({ idleSec: 0 })
  await r.svc.tick()
  expect(currentPresence()).toMatchObject({ state: 'here', by: 'auto' })
})

test('the board’s own page counts as input', async () => {
  isolatedHome()
  const r = rig({ mode: 'auto', idleMinutes: 10 })
  r.see({ idleSec: 900 })
  await r.svc.tick()
  expect(currentPresence().state).toBe('away')
  // Used from the phone while the computer idles: the page's request is input on this computer
  // only when it comes from the board's own page (the server decides that); touch() trusts it.
  r.svc.touch()
  expect(currentPresence().state).toBe('here')
  // Mode 'off' is the manual switch alone: a touch changes nothing.
  r.cfg.presence = { mode: 'off' }
  r.svc.set('away', 'phone')
  r.svc.touch()
  expect(currentPresence().state).toBe('away')
})

test('turned on under a running board marks the briefed sessions; turned off forgets everything', async () => {
  isolatedHome()
  writeCard('s1', { briefV: 5 })
  writeCard('s2', { title: 'never briefed' })
  const r = rig(undefined)
  r.svc.refresh()
  expect(readCard('s1')).not.toHaveProperty('presenceSeen')
  expect(r.changes).toBe(0)
  r.cfg.presence = { mode: 'auto' }
  await r.svc.tick()
  expect(readCard('s1')?.presenceSeen).toBe(-1)
  expect(readCard('s2')).not.toHaveProperty('presenceSeen')
  expect(r.changes).toBeGreaterThan(0)
  r.svc.set('away', 'cli')
  r.cfg.presence = undefined
  r.svc.refresh()
  expect(existsSync(presenceFile())).toBe(false)
  expect(readCard('s1')).not.toHaveProperty('presenceSeen')
  expect(r.svc.view()).toBeNull()
})

test('without MokuPilot here: no call is read, the view is the one before', async () => {
  isolatedHome()
  const r = rig({ mode: 'auto', idleMinutes: 10 })
  r.see({ idleSec: 5 })
  for (let i = 0; i < 5; i++) {
    await r.svc.tick()
    r.later(30_000)
  }
  expect(r.looks.call).toBe(0)
  // Looked up once a minute, not on every tick.
  expect(r.looks.here).toBeLessThanOrEqual(3)
  expect(r.svc.view()).toEqual({ ...NO_PRESENCE, mode: 'auto', idleMinutes: 10, hint: null, detects: true })
  // `"mokupilot": false`: not even looked up.
  const off = rig({ mode: 'auto' }, false)
  off.mokupilot(true, '7:1')
  await off.svc.tick()
  expect(off.svc.view()).not.toHaveProperty('calls')
  expect([off.looks.here, off.looks.call]).toEqual([0, 0])
  expect(currentPresence().state).toBe('here')
})

test('a MokuPilot call puts the user on it and back; the view offers one by hand where MokuPilot runs', async () => {
  isolatedHome()
  const r = rig({ mode: 'suggest', idleMinutes: 10 })
  r.mokupilot(true)
  r.see({ idleSec: 5 })
  await r.svc.tick()
  expect(r.svc.view()).toMatchObject({ state: 'here', calls: true })
  r.mokupilot(true, '7:1')
  r.later(30_000)
  await r.svc.tick()
  expect(readPresence()).toEqual({ state: 'call', since: 31_000, by: 'auto', from: 'auto', before: 'here' })
  expect(r.logs).toContain('presence: call (detected)')
  // The call runs on without input; the board's page used meanwhile changes nothing.
  r.see({ idleSec: 1800 })
  r.later(30_000)
  await r.svc.tick()
  r.svc.touch()
  expect(currentPresence().state).toBe('call')
  r.mokupilot(true, null)
  r.see({ idleSec: 2 })
  r.later(30_000)
  await r.svc.tick()
  expect(currentPresence()).toMatchObject({ state: 'here', by: 'auto' })
  expect(currentPresence()).not.toHaveProperty('before')
  // By hand, as the other states.
  r.svc.set('call', 'web')
  expect(r.svc.view()).toMatchObject({ state: 'call', by: 'user', before: 'here' })
  r.later(30_000)
  await r.svc.tick()
  expect(currentPresence().state).toBe('call')
  r.svc.set('here', 'web')
  expect(currentPresence().state).toBe('here')
})

test('a call that cannot be read changes nothing; one no longer watched ends if the board set it', async () => {
  isolatedHome()
  const r = rig({ mode: 'auto', idleMinutes: 10 })
  r.mokupilot(true, '7:1')
  r.see({ idleSec: 5 })
  await r.svc.tick()
  expect(currentPresence().state).toBe('call')
  // Held by another program a moment: still on the call, and no new call when it reads again.
  r.unreadable()
  r.later(30_000)
  await r.svc.tick()
  r.mokupilot(true, '7:1')
  r.later(30_000)
  await r.svc.tick()
  expect(currentPresence()).toMatchObject({ state: 'call', since: 1_000 })
  // `"mokupilot": false` mid-call: the board's call ends.
  r.cfg.mokupilot = false
  r.later(30_000)
  await r.svc.tick()
  expect(currentPresence()).toMatchObject({ state: 'here', by: 'auto' })
  // One the user set stays theirs.
  r.svc.set('call', 'cli')
  r.later(30_000)
  await r.svc.tick()
  expect(currentPresence()).toMatchObject({ state: 'call', by: 'user' })
})
