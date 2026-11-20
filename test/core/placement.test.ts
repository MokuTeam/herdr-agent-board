// Placement by device order (design: docs/design/nodes, 8.1 to 8.3, and 14, T7), as a table over
// views built here: no device is asked, nothing is started.
import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  type DeviceSettings,
  type DeviceState,
  type DeviceStatus,
  gateNext,
  liveReservations,
  needsFresh,
  type PlacementConfig,
  type PlacementView,
  place,
  reservedOn,
  type Task,
  type Verdict,
} from '../../src/core/placement.ts'

const NOW = 1_795_210_000_000

const status = (o: Partial<DeviceStatus> = {}): DeviceStatus => ({
  memAvailableMb: 20_000,
  load: [0.1, 0.1, 0.1],
  cpus: 8,
  sessions: { awake: 0, working: 0, asleep: 0 },
  profiles: [{ id: 'default', loggedIn: true }],
  agents: ['claude'],
  commit: 'ee32fc89',
  api: 1,
  at: NOW - 5_000,
  ...o,
})

const device = (id: string, o: Partial<DeviceSettings> = {}): DeviceSettings => ({
  id,
  maxSessions: 3,
  minFreeMemMb: 1200,
  maxLoad: 0.9,
  tags: [],
  paused: false,
  drain: false,
  ...o,
})

const state = (o: Partial<DeviceState> = {}): DeviceState => ({
  status: status(),
  online: true,
  reserved: 0,
  gateClosed: false,
  ...o,
})

/** server-1, server-2, local: both servers 3 sessions with memory to spare, this computer 20. */
function view(
  o: {
    config?: Partial<PlacementConfig>
    settings?: Record<string, Partial<DeviceSettings>>
    devices?: Record<string, Partial<DeviceState>>
  } = {},
): PlacementView {
  const settings = {
    'server-1': device('server-1', o.settings?.['server-1']),
    'server-2': device('server-2', o.settings?.['server-2']),
    local: device('local', { maxSessions: 20, minFreeMemMb: 4800, maxLoad: null, ...o.settings?.local }),
  }
  return {
    config: {
      order: ['server-1', 'server-2', 'local'],
      whenFull: 'local',
      lanes: 'all',
      devices: settings,
      ...o.config,
    },
    master: { api: 1, commit: 'ee32fc89' },
    devices: {
      'server-1': state(o.devices?.['server-1']),
      'server-2': state(o.devices?.['server-2']),
      local: state({ status: status({ sessions: { awake: 5, working: 2, asleep: 9 } }), ...o.devices?.local }),
    },
  }
}

const task = (o: Partial<Task> = {}): Task => ({
  lane: 'atlas',
  profile: 'default',
  agent: 'claude',
  origin: 'local',
  portable: { ok: true },
  byHand: true,
  ...o,
})

/** The placer's part in a run of starts: each start counted on its device at once, the status unchanged. */
function run(v: PlacementView, starts: number, t: Task = task()): Verdict[] {
  const out: Verdict[] = []
  const devices = structuredClone(v.devices) as Record<string, DeviceState>
  for (let i = 0; i < starts; i++) {
    const verdict = place(t, { ...v, devices }, NOW)
    out.push(verdict)
    const d = 'on' in verdict ? devices[verdict.on] : undefined
    if (d) d.reserved++
  }
  return out
}

const where = (vs: Verdict[]) => vs.map(v => ('on' in v ? v.on : 'wait' in v ? 'wait' : 'refuse'))

describe('the acceptance run of 8.2', () => {
  test('seven starts by hand: 3 on server-1, 3 on server-2, the seventh here', () => {
    const vs = run(view(), 7)
    assert.deepEqual(where(vs), ['server-1', 'server-1', 'server-1', 'server-2', 'server-2', 'server-2', 'local'])
    assert.deepEqual(vs[6], { on: 'local', why: 'room' })
  })

  test('the seventh waits with whenFull "wait" and this computer full, or set to 0, naming the first blocker', () => {
    const full = run(
      view({
        config: { whenFull: 'wait' },
        devices: { local: { status: status({ sessions: { awake: 20, working: 0, asleep: 0 } }) } },
      }),
      7,
    )
    assert.deepEqual(full[6], { wait: 'server-1: 3 of 3 sessions' })
    const zero = run(view({ config: { whenFull: 'wait' }, settings: { local: { maxSessions: 0 } } }), 7)
    assert.deepEqual(where(zero).slice(5), ['server-2', 'wait'])
  })

  test('fills in order, never spreads: server-2 gets nothing while server-1 has room', () => {
    const v = view({ devices: { 'server-1': { status: status({ sessions: { awake: 2, working: 2, asleep: 0 } }) } } })
    assert.deepEqual(place(task(), v, NOW), { on: 'server-1', why: 'room' })
    // Sleeping sessions hold no process and do not count.
    const asleep = view({
      devices: { 'server-1': { status: status({ sessions: { awake: 0, working: 0, asleep: 40 } }) } },
    })
    assert.deepEqual(place(task(), asleep, NOW), { on: 'server-1', why: 'room' })
  })
})

describe('seven starts inside one status age', () => {
  test('the status does not change between them: the reservations keep server-1 from taking all seven', () => {
    const v = view()
    // What the device's own status says, start after start: room every time.
    for (let i = 0; i < 7; i++) assert.deepEqual(place(task(), v, NOW), { on: 'server-1', why: 'room' })
    assert.deepEqual(where(run(v, 7)).filter(d => d === 'server-1').length, 3)
  })

  test('each reservation holds 800 MB: memory for three starts above the threshold takes three', () => {
    // 3600 free, 1200 kept: 3600, 2800, 2000 leave room, 1200 still does, 400 does not.
    const v = view({
      settings: { 'server-1': { maxSessions: null } },
      devices: { 'server-1': { status: status({ memAvailableMb: 3600 }) } },
    })
    assert.deepEqual(where(run(v, 5)), ['server-1', 'server-1', 'server-1', 'server-1', 'server-2'])
    const held = view({ devices: { 'server-1': { reserved: 3, status: status({ memAvailableMb: 3600 }) } } })
    assert.deepEqual(place(task(), { ...held, config: { ...held.config, whenFull: 'wait' } }, NOW), {
      on: 'server-2',
      why: 'room',
    })
  })

  test('reservations let go when the session shows, and after 180 s', () => {
    const list = [
      { id: 'a', device: 'server-1', at: NOW - 1_000 },
      { id: 'b', device: 'server-1', at: NOW - 179_999 },
      { id: 'c', device: 'server-1', at: NOW - 180_000 },
      { id: 'd', device: 'server-2', at: NOW - 10 },
    ]
    const live = liveReservations(list, NOW, new Set(['a']))
    assert.deepEqual(
      live.map(r => r.id),
      ['b', 'd'],
    )
    assert.equal(reservedOn(live, 'server-1'), 1)
    assert.equal(reservedOn(live, 'server-2'), 1)
    assert.equal(reservedOn(live, 'local'), 0)
  })
})

describe('the memory gate', () => {
  const s = { minFreeMemMb: 1200 }
  test('closes below minFreeMemMb and opens again only above 1.15 times it', () => {
    assert.equal(gateNext(s, status({ memAvailableMb: 1200 }), false), false)
    assert.equal(gateNext(s, status({ memAvailableMb: 1199 }), false), true)
    assert.equal(gateNext(s, status({ memAvailableMb: 1300 }), true), true)
    assert.equal(gateNext(s, status({ memAvailableMb: 1380 }), true), true)
    assert.equal(gateNext(s, status({ memAvailableMb: 1381 }), true), false)
    // No status: as it was. No threshold: never closed.
    assert.equal(gateNext(s, null, true), true)
    assert.equal(gateNext({ minFreeMemMb: null }, status({ memAvailableMb: 1 }), true), false)
  })

  test('a closed gate needs the return threshold before the device takes a start again', () => {
    const at = (gateClosed: boolean) =>
      place(
        task(),
        view({
          config: { whenFull: 'wait' },
          devices: {
            'server-1': { gateClosed, status: status({ memAvailableMb: 1300 }) },
            'server-2': { status: status({ sessions: { awake: 3, working: 0, asleep: 0 } }) },
            local: { status: status({ memAvailableMb: 100 }) },
          },
        }),
        NOW,
      )
    assert.deepEqual(at(false), { on: 'server-1', why: 'room' })
    assert.deepEqual(at(true), { wait: 'server-1: 1300 MB free, needs 1380' })
  })

  test('free memory is the gate whatever the session count says', () => {
    const v = view({ devices: { 'server-1': { status: status({ memAvailableMb: 1100 }) } } })
    assert.deepEqual(place(task(), v, NOW), { on: 'server-2', why: 'room' })
  })
})

describe('load', () => {
  test('the 5 minute load per core over maxLoad leaves no room', () => {
    const v = view({ devices: { 'server-1': { status: status({ load: [0.1, 9.6, 0.1] }) } } })
    assert.deepEqual(place(task(), v, NOW), { on: 'server-2', why: 'room' })
    const wait = view({
      config: { whenFull: 'wait' },
      settings: { 'server-2': { paused: true }, local: { maxSessions: 0 } },
      devices: { 'server-1': { status: status({ load: [0.1, 9.6, 0.1] }) } },
    })
    assert.deepEqual(place(task(), wait, NOW), { wait: 'server-1: load 1.20 per core, limit 0.9' })
    // The 1 and 15 minute figures are not the test.
    const spike = view({ devices: { 'server-1': { status: status({ load: [60, 0.5, 60] }) } } })
    assert.deepEqual(place(task(), spike, NOW), { on: 'server-1', why: 'room' })
  })

  test('a device with no load average is judged by sessions and memory alone', () => {
    const v = view({
      settings: { 'server-1': { maxLoad: 0.01 } },
      devices: { 'server-1': { status: status({ load: null }) } },
    })
    assert.deepEqual(place(task(), v, NOW), { on: 'server-1', why: 'room' })
  })
})

describe('devices that cannot take a start', () => {
  test('offline, and a status older than 45 s, go to the next device; needsFresh names the stale ones', () => {
    assert.deepEqual(place(task(), view({ devices: { 'server-1': { online: false } } }), NOW), {
      on: 'server-2',
      why: 'room',
    })
    const stale = view({
      devices: { 'server-1': { status: status({ at: NOW - 45_001 }) }, 'server-2': { status: null } },
    })
    assert.deepEqual(place(task(), stale, NOW), { on: 'local', why: 'room' })
    assert.deepEqual(needsFresh(task(), stale, NOW), ['server-1', 'server-2'])
    // At 45 s it is still fresh; an offline device is not asked; this computer never is.
    const edge = view({
      devices: {
        'server-1': { status: status({ at: NOW - 45_000 }) },
        'server-2': { online: false, status: null },
        local: { status: status({ at: NOW - 600_000 }) },
      },
    })
    assert.deepEqual(needsFresh(task(), edge, NOW), [])
    assert.deepEqual(needsFresh(task({ pin: { device: 'server-2' } }), stale, NOW), ['server-2'])
  })

  test('the wait names an offline device when it is the first blocker', () => {
    const v = view({
      config: { whenFull: 'wait' },
      settings: { local: { maxSessions: 0 } },
      devices: { 'server-1': { online: false }, 'server-2': { status: null } },
    })
    assert.deepEqual(place(task(), v, NOW), { wait: 'server-1: offline' })
  })

  test('paused, draining, revoked: skipped; none left: refuse with each reason', () => {
    assert.deepEqual(place(task(), view({ settings: { 'server-1': { paused: true } } }), NOW), {
      on: 'server-2',
      why: 'room',
    })
    assert.deepEqual(place(task(), view({ settings: { 'server-1': { drain: true } } }), NOW), {
      on: 'server-2',
      why: 'room',
    })
    assert.deepEqual(place(task(), view({ devices: { 'server-1': { revoked: true } } }), NOW), {
      on: 'server-2',
      why: 'room',
    })
    const none = view({
      settings: { 'server-1': { paused: true }, 'server-2': { drain: true }, local: { paused: true } },
    })
    assert.deepEqual(place(task(), none, NOW), {
      refuse: 'server-1: paused; server-2: draining; local: paused',
    })
  })

  test('another commit or link version on a node: never placed there; this computer is the master', () => {
    const v = view({
      config: { whenFull: 'wait' },
      settings: { local: { maxSessions: 0 } },
      devices: {
        'server-1': { status: status({ commit: '4d7154cb' }) },
        'server-2': { status: status({ api: 2 }) },
        local: { status: status({ commit: 'whatever', api: 9, sessions: { awake: 0, working: 0, asleep: 0 } }) },
      },
    })
    assert.deepEqual(place(task(), v, NOW), { wait: 'local: 0 of 0 sessions' })
    const pinned = place(task({ pin: { device: 'server-1' } }), v, NOW)
    assert.deepEqual(pinned, { refuse: 'server-1: version 4d7154cb, this board ee32fc89' })
    assert.deepEqual(place(task({ pin: { device: 'server-2' } }), v, NOW), {
      refuse: 'server-2: link version 2, this board 1',
    })
  })

  test('the profile there, logged in, the agent kind and every needed tag', () => {
    const v = view({
      settings: { 'server-1': { profiles: { work: 'bsd' } }, 'server-2': { tags: ['linux', 'tests'] } },
      devices: {
        'server-1': {
          status: status({
            profiles: [
              { id: 'default', loggedIn: false },
              { id: 'bsd', loggedIn: true },
            ],
          }),
        },
        'server-2': { status: status({ profiles: [{ id: 'default', loggedIn: null }], agents: ['claude', 'pi'] }) },
      },
    })
    // The master's "work" is the node's "bsd".
    assert.deepEqual(place(task({ profile: 'work' }), v, NOW), { on: 'server-1', why: 'room' })
    // Not logged in: skipped. A login it cannot tell (null) is not a refusal.
    assert.deepEqual(place(task(), v, NOW), { on: 'server-2', why: 'room' })
    assert.deepEqual(place(task({ agent: 'pi' }), v, NOW), { on: 'server-2', why: 'room' })
    assert.deepEqual(place(task({ needs: ['tests'] }), v, NOW), { on: 'server-2', why: 'room' })
  })
})

describe('a pin', () => {
  test('to a device: that device only, even with room before it in the order', () => {
    assert.deepEqual(place(task({ pin: { device: 'server-2' } }), view(), NOW), { on: 'server-2', why: 'room' })
    const full = view({
      devices: { 'server-2': { status: status({ sessions: { awake: 3, working: 3, asleep: 0 } }) } },
    })
    // Full: it waits for that device, it does not start here even by hand with whenFull "local".
    assert.deepEqual(place(task({ pin: { device: 'server-2' } }), full, NOW), { wait: 'server-2: 3 of 3 sessions' })
    assert.deepEqual(place(task({ pin: { device: 'server-9' } }), view(), NOW), { refuse: 'no device for server-9' })
  })

  test('to a tag: the devices that have it, in order', () => {
    const v = view({ settings: { 'server-2': { tags: ['tests'] }, local: { tags: ['tests'] } } })
    assert.deepEqual(place(task({ pin: { tag: 'tests' } }), v, NOW), { on: 'server-2', why: 'room' })
    assert.deepEqual(where(run(v, 4, task({ pin: { tag: 'tests' } }))), ['server-2', 'server-2', 'server-2', 'local'])
    assert.deepEqual(place(task({ pin: { tag: 'gpu' } }), v, NOW), { refuse: 'no device for tag gpu' })
  })
})

describe('whenFull', () => {
  // Every device full; this computer fits.
  const full = (whenFull: 'local' | 'wait') =>
    view({
      config: { whenFull },
      devices: {
        'server-1': { reserved: 3 },
        'server-2': { status: status({ sessions: { awake: 3, working: 0, asleep: 0 } }) },
        local: { status: status({ memAvailableMb: 1000 }) },
      },
    })

  test('"local": a start by hand goes here whatever this computer\'s thresholds say; one not by hand waits', () => {
    assert.deepEqual(place(task(), full('local'), NOW), { on: 'local', why: 'full' })
    assert.deepEqual(place(task({ byHand: false }), full('local'), NOW), { wait: 'server-1: 3 of 3 sessions' })
  })

  test('"wait": by hand or not, it waits', () => {
    assert.deepEqual(place(task(), full('wait'), NOW), { wait: 'server-1: 3 of 3 sessions' })
    assert.deepEqual(place(task({ byHand: false }), full('wait'), NOW), { wait: 'server-1: 3 of 3 sessions' })
  })

  test('"local" only when this computer fits', () => {
    const v = full('local')
    const noLogin = {
      ...v,
      devices: { ...v.devices, local: state({ status: status({ profiles: [{ id: 'default', loggedIn: false }] }) }) },
    }
    assert.deepEqual(place(task(), noLogin, NOW), { wait: 'server-1: 3 of 3 sessions' })
  })
})

describe('lanes', () => {
  const lanes = (l: PlacementConfig['lanes'], lane = 'atlas') =>
    place(task({ lane }), view({ config: { lanes: l } }), NOW)

  test('a lane ticked, or "all": it may leave', () => {
    assert.deepEqual(lanes(['atlas', 'tools']), { on: 'server-1', why: 'room' })
    assert.deepEqual(lanes('all'), { on: 'server-1', why: 'room' })
  })

  test('a lane unticked, and no lanes at all: nothing leaves, it starts where its folder is', () => {
    const home = { on: 'local', why: 'home', home: { kind: 'lane' } }
    assert.deepEqual(lanes(['tools']), home)
    assert.deepEqual(lanes(undefined), home)
    assert.deepEqual(lanes(null), home)
    assert.deepEqual(lanes([]), home)
    const { lanes: _, ...noKey } = view().config
    assert.deepEqual(place(task(), { ...view(), config: noKey }, NOW), home)
  })

  test('a task that is not portable stays home with its reason; home full waits, or starts by hand', () => {
    const changes = task({ portable: { ok: false, why: { kind: 'changes' } } })
    assert.deepEqual(place(changes, view(), NOW), { on: 'local', why: 'home', home: { kind: 'changes' } })
    const busy = view({ devices: { local: { status: status({ sessions: { awake: 20, working: 0, asleep: 0 } }) } } })
    assert.deepEqual(place({ ...changes, byHand: false }, busy, NOW), { wait: 'local: 20 of 20 sessions' })
    assert.deepEqual(place(changes, busy, NOW), { on: 'local', why: 'full', home: { kind: 'changes' } })
    // Its folder on a node: there or nowhere.
    const onNode = task({ origin: 'server-2', portable: { ok: false, why: { kind: 'unpushed' } } })
    assert.deepEqual(place(onNode, view(), NOW), { on: 'server-2', why: 'home', home: { kind: 'unpushed' } })
  })
})

describe('refuse', () => {
  test('when no candidate fits at all, with every reason', () => {
    assert.deepEqual(place(task({ agent: 'codex' }), view(), NOW), {
      refuse: 'server-1: no codex; server-2: no codex; local: no codex',
    })
    assert.deepEqual(place(task({ profile: 'work' }), view({ config: { order: ['server-1'] } }), NOW), {
      refuse: 'server-1: no profile work; server-2: no profile work; local: no profile work',
    })
    assert.deepEqual(place(task({ needs: ['gpu'] }), view({ config: { order: ['server-1', 'local'] } }), NOW), {
      refuse: 'server-1: no tag gpu; local: no tag gpu; server-2: no tag gpu',
    })
  })

  test('a device never heard from is not refused: it waits for its first status', () => {
    const v = view({
      config: { order: ['server-1'] },
      settings: { local: { paused: true }, 'server-2': { paused: true } },
      devices: { 'server-1': { status: null } },
    })
    assert.deepEqual(place(task(), v, NOW), { wait: 'server-1: no status yet' })
  })
})

describe('the config as T1 gives it', () => {
  test('devices as a list place the same as by id; the order gets the devices it misses, this computer last', () => {
    const v = view()
    const list = { ...v, config: { ...v.config, devices: Object.values(v.config.devices) } }
    assert.deepEqual(where(run(list, 7)), where(run(v, 7)))
    const short = { ...v, config: { ...v.config, order: ['server-2'] } }
    assert.deepEqual(where(run(short, 7)), [
      'server-2',
      'server-2',
      'server-2',
      'server-1',
      'server-1',
      'server-1',
      'local',
    ])
  })
})

describe('edges', () => {
  test('a needed tag is config, not status: a silent device without it refuses, and whenFull does not start here', () => {
    const v = view({
      config: { order: ['server-1'] },
      settings: { 'server-2': { paused: true } },
      devices: { 'server-1': { status: null }, local: { status: null } },
    })
    assert.deepEqual(place(task({ needs: ['gpu'] }), v, NOW), {
      refuse: 'server-1: no tag gpu; server-2: paused; local: no tag gpu',
    })
    const tagged = view({ settings: { 'server-1': { tags: ['gpu'] } }, devices: { 'server-1': { status: null } } })
    assert.deepEqual(place(task({ needs: ['gpu'] }), tagged, NOW), { wait: 'server-1: no status yet' })
  })

  test('needsFresh asks only devices the task could use: home, not paused, draining or revoked', () => {
    const stale = view({
      settings: { 'server-2': { paused: true } },
      devices: { 'server-1': { status: status({ at: NOW - 60_000 }) }, 'server-2': { status: null } },
    })
    assert.deepEqual(needsFresh(task(), stale, NOW), ['server-1'])
    assert.deepEqual(needsFresh(task({ portable: { ok: false, why: { kind: 'changes' } } }), stale, NOW), [])
    assert.deepEqual(
      needsFresh(task({ lane: 'x' }), { ...stale, config: { ...stale.config, lanes: ['atlas'] } }, NOW),
      [],
    )
    assert.deepEqual(
      needsFresh(task({ origin: 'server-1', portable: { ok: false, why: { kind: 'unpushed' } } }), stale, NOW),
      ['server-1'],
    )
    const revoked = view({ devices: { 'server-1': { revoked: true, status: null }, 'server-2': { status: null } } })
    assert.deepEqual(needsFresh(task(), revoked, NOW), ['server-2'])
  })

  test('a pin and a task that cannot leave: it starts where its folder is, with the reason', () => {
    const v = view()
    const pinned = task({ pin: { device: 'server-1' }, portable: { ok: false, why: { kind: 'changes' } } })
    assert.deepEqual(place(pinned, v, NOW), { on: 'local', why: 'home', home: { kind: 'changes' } })
  })

  test('the gate counts reservations in the free figure, and its return threshold is exact', () => {
    // 2150 free less one start's 800 is 1350: enough with the gate open, not above 1380 with it closed.
    const at = (gateClosed: boolean) =>
      place(
        task(),
        view({
          config: { whenFull: 'wait' },
          settings: { 'server-2': { paused: true }, local: { maxSessions: 0 } },
          devices: { 'server-1': { gateClosed, reserved: 1, status: status({ memAvailableMb: 2150 }) } },
        }),
        NOW,
      )
    assert.deepEqual(at(false), { on: 'server-1', why: 'room' })
    assert.deepEqual(at(true), { wait: 'server-1: 1350 MB free, needs 1380' })
    // 100 × 1.15 is 114.99999999999999 in floating point: 115 is not above it.
    assert.equal(gateNext({ minFreeMemMb: 100 }, status({ memAvailableMb: 115 }), true), true)
    assert.equal(gateNext({ minFreeMemMb: 100 }, status({ memAvailableMb: 116 }), true), false)
  })

  test('the profile map is for nodes: this computer looks up its own ids', () => {
    const v = view({
      config: { order: ['local'] },
      settings: { local: { profiles: { default: 'elsewhere' } } },
    })
    assert.deepEqual(place(task(), v, NOW), { on: 'local', why: 'room' })
  })
})
