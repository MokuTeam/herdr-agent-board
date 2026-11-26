import { expect, test } from 'bun:test'
import {
  ownerCliCommand,
  RELAY_OWNER_SETTINGS,
  relayOwnerSetting,
  relayTablePath,
} from '../../src/core/master-relay.ts'
import {
  childOfLine,
  depthOf,
  editedSpawnLimits,
  FRESH_MS,
  KEEP_MS,
  kept,
  liveChildren,
  needsAlive,
  PENDING_MS,
  SPAWN_DEFAULTS,
  type SpawnEntry,
  type SpawnLimits,
  sameParty,
  spawnLimitsOf,
  spawnVerdict,
} from '../../src/core/spawn-limits.ts'

// Limits on agent starts (#815): the rules without I/O.
const NOW = 1_800_000_000_000
const MIN = 60_000
const atlas = { session: 'atlas-sid', pane: 'w1:p1' }
const ben = { session: 'ben-sid', pane: 'w1:p2' }
const cleo = { session: 'cleo-sid', pane: 'w1:p3' }
let n = 0
const entry = (by: SpawnEntry['by'], ago: number, child?: SpawnEntry['child']): SpawnEntry => ({
  id: `e${++n}`,
  at: NOW - ago,
  by,
  name: `start ${n}`,
  ...(child && { child }),
})
const limits = (o: Partial<SpawnLimits> = {}): SpawnLimits => ({ ...SPAWN_DEFAULTS, ...o })
const all = () => true
const none = () => false

test('the defaults leave room for a master that runs about five and starts dozens a day', () => {
  expect(SPAWN_DEFAULTS).toEqual({ agents: true, children: 10, depth: 3, perHour: 30 })
  expect(spawnLimitsOf(undefined)).toEqual(SPAWN_DEFAULTS)
  // Five running children, twenty-five starts spread over the day: still free to start.
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => entry(atlas, 10 * MIN + i, { pane: `w2:p${i}` })),
    ...Array.from({ length: 20 }, (_, i) => entry(atlas, 2 * 3600_000 + i * MIN, { pane: `w3:p${i}` })),
  ]
  const running = (p: { pane?: string }) => !!p.pane?.startsWith('w2:')
  expect(spawnVerdict(SPAWN_DEFAULTS, entries, atlas, NOW, running)).toEqual({ ok: true, depth: 1 })
})

test('config.json values: wrong ones fall back to the default, too large is the largest, 0 is no limit', () => {
  expect(spawnLimitsOf({ agents: false, children: 0, depth: 5, perHour: 'x' })).toEqual({
    agents: false,
    children: 0,
    depth: 5,
    perHour: 30,
  })
  expect(spawnLimitsOf({ children: -1, depth: 2.5 })).toEqual(SPAWN_DEFAULTS)
  // Past the largest: the largest, not a stricter default.
  expect(spawnLimitsOf({ perHour: 5000 }).perHour).toBe(1000)
  expect(spawnLimitsOf([1, 2])).toEqual(SPAWN_DEFAULTS)
})

test('an edit from Settings: a default is not written, nothing left takes the key out, a wrong value refuses', () => {
  expect(editedSpawnLimits(undefined, { children: 5 })).toEqual({ children: 5 })
  expect(editedSpawnLimits({ children: 5, depth: 2 }, { children: 10 })).toEqual({ depth: 2 })
  expect(editedSpawnLimits({ children: 5 }, { children: 10 })).toBeUndefined()
  expect(editedSpawnLimits({ note: 'kept' }, { agents: false })).toEqual({ note: 'kept', agents: false })
  expect(editedSpawnLimits(undefined, { perHour: 0 })).toEqual({ perHour: 0 })
  for (const bad of [
    {},
    { children: -1 },
    { depth: 1.5 },
    { agents: 'no' },
    { other: 1 },
    null,
    [],
    'x',
    { perHour: 1001 },
  ])
    expect(editedSpawnLimits(undefined, bad)).toBeNull()
})

test('sessions are the same by their ids when both have one, else by their panes', () => {
  expect(sameParty(atlas, { session: 'atlas-sid' })).toBe(true)
  expect(sameParty(atlas, { session: 'other', pane: 'w1:p1' })).toBe(false)
  expect(sameParty({ pane: 'w1:p1' }, atlas)).toBe(true)
  expect(sameParty({ pane: 'w1:p9' }, atlas)).toBe(false)
  expect(sameParty({}, {})).toBe(false)
})

test('agent starts off: refused with one line', () => {
  const v = spawnVerdict(limits({ agents: false }), [], atlas, NOW, all)
  expect(v.ok).toBe(false)
  if (v.ok) return
  expect(v.rule).toBe('agents')
  expect(v.line).toContain('may not start sessions')
  expect(v.line).not.toContain('\n')
})

test('children: running ones count, ended ones do not; fresh and waiting starts count whatever herdr says', () => {
  const entries = [
    entry(atlas, 30 * MIN, { pane: 'w2:p1' }),
    entry(atlas, 30 * MIN, { pane: 'w2:p2' }),
    entry(atlas, FRESH_MS / 2, { pane: 'w2:p3' }),
    entry(atlas, PENDING_MS / 2),
    entry(atlas, PENDING_MS * 2),
    entry(ben, MIN, { pane: 'w2:p4' }),
  ]
  // All running: two old ones, the fresh one and the waiting one.
  expect(liveChildren(entries, atlas, NOW, all)).toBe(4)
  // None running by herdr: the fresh one and the waiting one still count; one waiting too long does not.
  expect(liveChildren(entries, atlas, NOW, none)).toBe(2)
  const at3 = limits({ children: 3 })
  const refused = spawnVerdict(at3, entries, atlas, NOW, all)
  expect(refused.ok).toBe(false)
  if (!refused.ok) {
    expect([refused.rule, refused.count, refused.limit]).toEqual(['children', 4, 3])
    expect(refused.line).toContain('4 sessions this session started still run, the limit is 3')
  }
  expect(spawnVerdict(at3, entries, atlas, NOW, none).ok).toBe(true)
  expect(spawnVerdict(limits({ children: 0 }), entries, atlas, NOW, all).ok).toBe(true)
})

test('depth counts the chain of starts over parents that still run', () => {
  // atlas (the owner's) started ben, ben started cleo.
  const entries = [entry(atlas, 20 * MIN, ben), entry(ben, 10 * MIN, cleo)]
  expect(depthOf(entries, atlas, all)).toBe(0)
  expect(depthOf(entries, ben, all)).toBe(1)
  expect(depthOf(entries, cleo, all)).toBe(2)
  // ben gone: cleo stands at the top of what still runs (a session that restarts itself does not climb).
  expect(depthOf(entries, cleo, p => p.session !== 'ben-sid')).toBe(0)
  // atlas gone: ben still runs, so cleo is one level below it.
  expect(depthOf(entries, cleo, p => p.session !== 'atlas-sid')).toBe(1)
  const at2 = limits({ depth: 2 })
  const v = spawnVerdict(at2, entries, cleo, NOW, all)
  expect(v.ok).toBe(false)
  if (!v.ok) expect([v.rule, v.count, v.limit]).toEqual(['depth', 3, 2])
  expect(spawnVerdict(at2, entries, ben, NOW, all)).toEqual({ ok: true, depth: 2 })
  expect(spawnVerdict(limits({ depth: 0 }), entries, cleo, NOW, all).ok).toBe(true)
})

test('depth: a loop in the ledger ends', () => {
  const entries = [entry(atlas, 2 * MIN, ben), entry(ben, MIN, atlas)]
  expect(depthOf(entries, atlas, all)).toBeLessThanOrEqual(2)
})

test('per hour: starts in the last hour count, whatever became of them', () => {
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => entry(atlas, (10 + i) * MIN, { pane: `w9:p${i}` })),
    entry(atlas, 61 * MIN, { pane: 'w9:old' }),
  ]
  const v = spawnVerdict(limits({ perHour: 3 }), entries, atlas, NOW, none)
  expect(v.ok).toBe(false)
  if (!v.ok) {
    expect([v.rule, v.count, v.limit]).toEqual(['perHour', 3, 3])
    expect(v.line).toContain('started 3 sessions in the last hour, the limit is 3')
  }
  expect(spawnVerdict(limits({ perHour: 4 }), entries, atlas, NOW, none).ok).toBe(true)
  expect(spawnVerdict(limits({ perHour: 3 }), entries, ben, NOW, none).ok).toBe(true)
})

test('herdr is needed only when every session taken as running would refuse on children or depth', () => {
  const two = [entry(atlas, 30 * MIN, { pane: 'w2:p1' }), entry(atlas, 30 * MIN, { pane: 'w2:p2' })]
  expect(needsAlive(SPAWN_DEFAULTS, two, atlas, NOW)).toBe(false)
  expect(needsAlive(limits({ children: 2 }), two, atlas, NOW)).toBe(true)
  // Refused by a rule that does not depend on it: nothing to ask.
  expect(needsAlive(limits({ perHour: 2 }), two, atlas, NOW)).toBe(false)
  expect(needsAlive(limits({ agents: false }), [], atlas, NOW)).toBe(false)
})

test('the session a spawn line names: here, on a node, or none while it waits', () => {
  expect(childOfLine('pane=wA:p9 name=Acme agent=acme')).toEqual({ pane: 'wA:p9' })
  expect(childOfLine('pane=@laptop:w1:p2 name=Acme agent=@laptop:sid device=laptop session=sid')).toEqual({
    pane: '@laptop:w1:p2',
    session: 'sid',
  })
  expect(childOfLine('queued=l-1 name=Acme waiting=laptop:full')).toEqual({})
})

test("the limits are the owner's: no session nor node reaches them, and a node's terminal never spawns as the owner", () => {
  // Settings → Board & Agents writes /api/settings, which no node relays to its master and no
  // relayed session passes: each computer's limits are its owner's alone.
  expect(relayTablePath('POST', '/api/settings')).toBe(false)
  expect(RELAY_OWNER_SETTINGS.has('/api/settings')).toBe(false)
  expect(relayOwnerSetting('POST', '/api/settings', { kind: 'session', key: 'ben-sid' } as never)).toBe(false)
  // A sessionless terminal's commands that go up as the owner's: never a start.
  expect(ownerCliCommand('spawn', [])).toBe(false)
})

test('the ledger keeps a week', () => {
  const old = entry(atlas, KEEP_MS + 1)
  const young = entry(atlas, KEEP_MS - 1)
  expect(kept([old, young], NOW)).toEqual([young])
})
