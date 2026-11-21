// The shown figures of a node's status (#500, core/nodes.ts statusShown): what the Devices row
// shows, rounded as it shows it. A status every 30 s that rounds the same is no news to any page.
import { expect, test } from 'bun:test'
import { type NodeStatus, statusShown } from '../../src/core/nodes.ts'

const status = (more: Partial<NodeStatus> = {}): NodeStatus =>
  ({
    ...{
      api: 1,
      id: 'server-1',
      version: '0.1.0',
      commit: 'abc',
      platform: 'linux',
      arch: 'x64',
      cpus: 8,
      memTotalMb: 32013,
      memAvailableMb: 21480,
      load: [0.42, 0.61, 0.58],
      sessions: { awake: 2, working: 1, asleep: 5 },
      launches: 0,
      workRootFreeMb: 148000,
      profiles: [{ id: 'default', loggedIn: true, bundle: null }],
      agents: ['claude'],
      at: 1,
    },
    ...more,
  }) as NodeStatus

test('the same figures, rounded: the same key; the time, the free disk and the launches do not count', () => {
  const one = statusShown(status())
  for (const more of [
    { at: 99 },
    { memAvailableMb: 21_520 },
    { load: [3, 0.64, 2] as [number, number, number] },
    { workRootFreeMb: 1 },
    { launches: 3 },
  ])
    expect([more, statusShown(status(more))]).toEqual([more, one])
})

test('a figure past its rounding, null against a value, a login, a bundle, the commit: another key', () => {
  const one = statusShown(status())
  for (const more of [
    { memAvailableMb: 21_380 },
    { memAvailableMb: null },
    { load: [0.42, 0.66, 0.58] as [number, number, number] },
    { load: null },
    { sessions: { awake: 3, working: 1, asleep: 5 } },
    { sessions: { awake: 2, working: 2, asleep: 5 } },
    { sessions: { awake: 2, working: 1, asleep: 4 } },
    { profiles: [{ id: 'default', loggedIn: false, bundle: null }] },
    { profiles: [{ id: 'default', loggedIn: true, bundle: { seq: 3, hash: 'f'.repeat(64) } }] },
    { commit: 'def' },
  ])
    expect([more, statusShown(status(more)) === one]).toEqual([more, false])
  expect(statusShown(null)).toBe('')
})

test('its git facts (#609): a login or an identity coming moves the key; a status without them keys as before', () => {
  const before = status({ programs: ['git', 'gh'], git: { identity: false, logins: [] } })
  const key = statusShown(before)
  for (const more of [
    { git: { identity: true, logins: [] } },
    { git: { identity: false, logins: [{ host: 'github.com', user: 'owner' }] } },
    { programs: ['git'] },
  ])
    expect([
      more,
      statusShown(status({ programs: ['git', 'gh'], git: { identity: false, logins: [] }, ...more })) === key,
    ]).toEqual([more, false])
  expect(statusShown(status({ programs: ['git'] }))).toBe(statusShown(status()))
})
