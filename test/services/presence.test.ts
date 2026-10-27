// The board's presence service (#172) against a fake computer and clock: auto and suggest
// detection, the manual switch winning until the next clear change, the board's own page counting
// as input, and presence turned on and off under a running board. Nothing reaches a session but
// the mark on its card.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { currentPresence, presenceFile, readPresence } from '../../src/adapters/presence-store.ts'
import type { Observation } from '../../src/core/presence.ts'
import type { Config } from '../../src/core/types.ts'
import { createPresence } from '../../src/services/presence.ts'
import { isolatedHome } from '../support/env.ts'

function rig(presence: Config['presence']) {
  const cfg: Pick<Config, 'presence'> = { presence }
  let obs: Observation = { idleSec: null, locked: null }
  let clock = 1_000
  let changes = 0
  const logs: string[] = []
  let asked = 0
  const svc = createPresence({
    cfg,
    log: l => logs.push(l),
    onChange: () => changes++,
    sessions: () => ['s1', 's2'],
    observe: async () => {
      asked++
      return obs
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
