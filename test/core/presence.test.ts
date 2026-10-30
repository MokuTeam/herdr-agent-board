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

// A MokuPilot call (#276): observations carry its id while it runs, null once none runs.
const onCall = (id: string, obs: Observation = idle(0)): Observation => ({ ...obs, call: id })
const noCall = (obs: Observation = idle(0)): Observation => ({ ...obs, call: null })

/** Steps through observations as the board does: each flip recorded as the board records it. */
function drive(start: Presence, cfg: PresenceConfig) {
  let p = start
  let mem: StepMemory | null = null
  let clock = 10_000
  return {
    get p() {
      return p
    },
    set(next: Presence) {
      p = next
    },
    step(obs: Observation) {
      const s = presenceStep(p, obs, cfg, mem)
      mem = s.memory
      clock += 1000
      if (s.flip && s.flip !== p.state)
        p =
          s.flip === 'call'
            ? { state: 'call', since: clock, by: 'auto', from: 'auto', before: p.state as 'here' | 'away' }
            : { state: s.flip, since: clock, by: 'auto', from: 'auto' }
      return s
    },
  }
}

test('a MokuPilot call: on while it runs, back to the state before once it ends; idle and a lock say nothing meanwhile', () => {
  for (const mode of ['auto', 'suggest'] as const) {
    const d = drive(NO_PRESENCE, { mode, idleMinutes: 10 })
    assert.equal(d.step(noCall()).flip, undefined)
    assert.equal(d.step(onCall('7:1')).flip, 'call')
    assert.deepEqual([d.p.state, d.p.before], ['call', 'here'])
    // A long call without typing, a locked screen: still on the call, nothing offered.
    for (const obs of [idle(40), LOCKED, idle(0)]) assert.deepEqual(d.step(onCall('7:1', obs)), {
      hint: null,
      memory: { since: d.p.since, agreed: true, call: '7:1' },
    })
    assert.equal(d.step(noCall()).flip, 'here')
    assert.equal(d.p.state, 'here')
  }
  // Away before it: away after it.
  const d = drive({ state: 'away', since: 5, by: 'auto', from: 'auto' }, AUTO)
  d.step(onCall('7:2', idle(0)))
  assert.deepEqual([d.p.state, d.p.before], ['call', 'away'])
  assert.equal(d.step(noCall(idle(30))).flip, 'away')
})

test('a call cleared by hand stays cleared until the next call; one set by hand ends by hand or with a call seen to end', () => {
  const d = drive(NO_PRESENCE, AUTO)
  d.step(onCall('7:1'))
  d.set({ state: 'here', since: 50_000, by: 'user', from: 'web' })
  assert.equal(d.step(onCall('7:1')).flip, undefined)
  assert.equal(d.step(onCall('7:1', idle(0))).flip, undefined)
  assert.equal(d.p.state, 'here')
  // The next call is a new one.
  assert.equal(d.step(onCall('7:9')).flip, 'call')

  // "On a call" pressed with no MokuPilot call: no look ends it, nor idle time.
  const byHand: Presence = { state: 'call', since: 60_000, by: 'user', from: 'web', before: 'here' }
  const h = drive(byHand, AUTO)
  for (const obs of [noCall(), noCall(idle(60)), noCall(LOCKED), idle(0)]) assert.equal(h.step(obs).flip, undefined)
  // A MokuPilot call meanwhile: its end ends this one too.
  assert.equal(h.step(onCall('8:1')).flip, undefined)
  assert.equal(h.step(noCall()).flip, 'here')
})

test('a call the board set ends on the first look without one (it ended while the board was down); a page touch is no look', () => {
  const p: Presence = { state: 'call', since: 1, by: 'auto', from: 'auto', before: 'away' }
  assert.equal(presenceStep(p, idle(0), AUTO, null).flip, undefined)
  assert.equal(presenceStep(p, noCall(), AUTO, null).flip, 'away')
  assert.equal(presenceStep({ ...p, before: undefined }, noCall(), AUTO, null).flip, 'here')
})

test('mode off: a call switches nothing', () => {
  const off: PresenceConfig = { mode: 'off', idleMinutes: 10 }
  assert.deepEqual(presenceStep(NO_PRESENCE, onCall('7:1'), off, null).flip, undefined)
  const p: Presence = { state: 'call', since: 1, by: 'auto', from: 'auto', before: 'here' }
  assert.deepEqual(presenceStep(p, noCall(), off, { since: 1, agreed: true, call: '7:1' }).flip, undefined)
})

test('no call, or no one looked: every step is the one before #276, its memory without a call', () => {
  const suggest: PresenceConfig = { mode: 'suggest', idleMinutes: 10 }
  const states: Presence[] = [
    NO_PRESENCE,
    { state: 'away', since: 5, by: 'user', from: 'cli' },
    { state: 'here', since: 6, by: 'auto', from: 'auto' },
  ]
  const memories: (StepMemory | null)[] = [null, { since: 5, agreed: true }, { since: 6, agreed: false }]
  for (const cfg of [AUTO, suggest])
    for (const p of states)
      for (const memory of memories)
        for (const obs of [idle(0), idle(20), LOCKED, NOTHING, { idleSec: null, locked: false }]) {
          const before = presenceStep(p, obs, cfg, memory)
          assert.deepEqual(presenceStep(p, noCall(obs), cfg, memory), before)
          assert.equal('call' in before.memory, false)
        }
})

test('the file keeps the state a call returns to; the line says the user is on a call and slow to answer', () => {
  assert.equal(isPresence({ state: 'call', since: 5, by: 'auto', from: 'auto', before: 'away' }), true)
  assert.equal(isPresence({ state: 'call', since: 5, by: 'user' }), true)
  assert.equal(isPresence({ state: 'call', since: 5, by: 'auto', before: 'call' }), false)
  const at = new Date(2026, 9, 30, 15, 40).getTime()
  const line = presenceLine({ state: 'call', since: at, by: 'auto' })
  assert.match(line, /^\[agent-board\] The user is on a call \(since 15:40\) and slow to answer/)
  assert.match(line, /board ask/)
  assert.doesNotMatch(line, /[\u2013\u2014]/)
})
