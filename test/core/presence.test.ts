// The user's presence (#172), its pure rules: config.json's section, what an observation says,
// the detection step with its "manual wins until the next clear change", and the line sessions read.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { brief } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import {
  DEFAULT_IDLE_MINUTES,
  isPresence,
  NO_PRESENCE,
  type Observation,
  type Presence,
  type PresenceConfig,
  presenceBrief,
  presenceConfig,
  presenceLine,
  presenceStep,
  type StepMemory,
  seenOf,
} from '../../src/core/presence.ts'

const AUTO: PresenceConfig = { mode: 'auto', idleMinutes: 10 }
const idle = (min: number): Observation => ({ idleSec: min * 60, locked: null })
const LOCKED: Observation = { idleSec: null, locked: true }
const NOTHING: Observation = { idleSec: null, locked: null }

test('presenceConfig: off without a section, `true` is auto, a section its mode and minutes', () => {
  for (const off of [undefined, null, false, 'yes', 3, []]) assert.equal(presenceConfig(off), null)
  assert.deepEqual(presenceConfig(true), { mode: 'auto', idleMinutes: DEFAULT_IDLE_MINUTES })
  assert.deepEqual(presenceConfig({}), { mode: 'auto', idleMinutes: DEFAULT_IDLE_MINUTES })
  assert.deepEqual(presenceConfig({ mode: 'suggest', idleMinutes: 5 }), { mode: 'suggest', idleMinutes: 5 })
  assert.deepEqual(presenceConfig({ mode: 'sometimes', idleMinutes: 0 }), {
    mode: 'auto',
    idleMinutes: DEFAULT_IDLE_MINUTES,
  })
  assert.deepEqual(presenceConfig({ mode: 'off', idleMinutes: 99999 }), {
    mode: 'off',
    idleMinutes: DEFAULT_IDLE_MINUTES,
  })
})

test('isPresence guards the file', () => {
  assert.equal(isPresence({ state: 'away', since: 5, by: 'user', from: 'cli' }), true)
  assert.equal(isPresence(NO_PRESENCE), true)
  assert.equal(isPresence({ state: 'gone', since: 5, by: 'user' }), false)
  assert.equal(isPresence({ state: 'away', since: '5', by: 'user' }), false)
  assert.equal(isPresence({ state: 'away', since: 5, by: 'user', from: 'pigeon' }), false)
  assert.equal(isPresence([]), false)
})

test('seenOf: a locked screen is away, idle past the minutes is away, input or an unlocked screen is back', () => {
  assert.equal(seenOf(LOCKED, 10), 'away')
  assert.equal(seenOf({ idleSec: 0, locked: true }, 10), 'away')
  assert.equal(seenOf(idle(10), 10), 'away')
  assert.equal(seenOf(idle(9.9), 10), 'back')
  assert.equal(seenOf({ idleSec: null, locked: false }, 10), 'back')
  assert.equal(seenOf(NOTHING, 10), null)
})

test('auto: away once idle, here again on input; the board’s own state agrees from the start', () => {
  let p: Presence = NO_PRESENCE
  let mem: StepMemory | null = null
  const step = (obs: Observation) => {
    const s = presenceStep(p, obs, AUTO, mem)
    mem = s.memory
    return s
  }
  assert.equal(step(idle(1)).flip, undefined)
  assert.equal(step(idle(11)).flip, 'away')
  p = { state: 'away', since: 1000, by: 'auto', from: 'auto' }
  assert.equal(step(idle(12)).flip, undefined)
  assert.equal(step(idle(0)).flip, 'here')
  p = { state: 'here', since: 2000, by: 'auto', from: 'auto' }
  assert.equal(step(LOCKED).flip, 'away')
})

test('manual wins until the next clear change', () => {
  // "Away" pressed at the keyboard: the input right after does not flip it back...
  const away: Presence = { state: 'away', since: 1000, by: 'user', from: 'web' }
  let s = presenceStep(away, idle(0), AUTO, null)
  assert.equal(s.flip, undefined)
  assert.equal(s.memory.agreed, false)
  s = presenceStep(away, idle(3), AUTO, s.memory)
  assert.equal(s.flip, undefined)
  // ...the user goes, detection agrees...
  s = presenceStep(away, idle(15), AUTO, s.memory)
  assert.equal(s.flip, undefined)
  assert.equal(s.memory.agreed, true)
  // ...and only their return flips it.
  s = presenceStep(away, idle(0), AUTO, s.memory)
  assert.equal(s.flip, 'here')

  // "Here" pressed while the screen says idle (say, reading at the desk): no flip to away until
  // input was seen, then idle again.
  const here: Presence = { state: 'here', since: 3000, by: 'user', from: 'phone' }
  s = presenceStep(here, idle(30), AUTO, null)
  assert.equal(s.flip, undefined)
  s = presenceStep(here, idle(31), AUTO, s.memory)
  assert.equal(s.flip, undefined)
  s = presenceStep(here, idle(0), AUTO, s.memory)
  s = presenceStep(here, idle(11), AUTO, s.memory)
  assert.equal(s.flip, 'away')

  // A memory of an older state is no memory of this one.
  const later: Presence = { state: 'away', since: 4000, by: 'user', from: 'cli' }
  assert.equal(presenceStep(later, idle(0), AUTO, { since: 1000, agreed: true }).flip, undefined)
})

test('suggest offers, off and silence do nothing', () => {
  const suggest: PresenceConfig = { mode: 'suggest', idleMinutes: 10 }
  const s = presenceStep(NO_PRESENCE, idle(20), suggest, null)
  assert.deepEqual([s.flip, s.hint], [undefined, 'away'])
  assert.equal(presenceStep(NO_PRESENCE, idle(1), suggest, null).hint, null)
  const off: PresenceConfig = { mode: 'off', idleMinutes: 10 }
  assert.deepEqual(presenceStep(NO_PRESENCE, idle(20), off, null).flip, undefined)
  assert.deepEqual(presenceStep(NO_PRESENCE, idle(20), off, null).hint, null)
  assert.deepEqual(presenceStep(NO_PRESENCE, NOTHING, AUTO, null).flip, undefined)
})

test('the line says where news goes: also to Telegram while away, the board and terminal while here', () => {
  const away = presenceLine({ state: 'away', since: 0, by: 'user' })
  assert.match(away, /^\[agent-board\] The user is away from the computer\./)
  assert.match(away, /Telegram/)
  const here = presenceLine(NO_PRESENCE)
  assert.match(here, /^\[agent-board\] The user is at the computer: the board and this terminal are enough/)
  const at = new Date(2026, 9, 24, 9, 5).getTime()
  assert.match(presenceLine({ state: 'away', since: at, by: 'auto' }), /\(since 09:05\)/)
})

test('the brief tells presence only when the setup turned it on', () => {
  const cfg = normalizeConfig({ language: 'en' })
  const env = { HERDR_PANE_ID: 'p1' }
  const without = brief(cfg, null, '/x', env)
  assert.doesNotMatch(without, /Presence|away from the computer|at the computer/)
  assert.equal(brief(cfg, null, '/x', env, 'Claude', null), without)
  const away: Presence = { state: 'away', since: 0, by: 'user' }
  const withIt = brief(cfg, null, '/x', env, 'Claude', away)
  assert.ok(withIt.includes(presenceBrief(away)))
  assert.match(withIt, /board presence prints it/)
})
