// spawn-agent --device (#760), the logic without the network: the option, the device the board's
// payload must list, and the call a node's spawn-agent sends its master, read back field by field.
import { describe, expect, test } from 'bun:test'
import { parseArgs, type SpawnOptions } from '../../src/core/launch/spawn-args.ts'
import { launchBody, pinnedDevice } from '../../src/core/launch/spawn-board.ts'
import { nodeSideLine, type SpawnCall, spawnCallArgv, spawnCallOf } from '../../src/core/launch/spawn-node.ts'
import { isRememberedCall, UPLINK_COMMANDS } from '../../src/core/node-uplink.ts'

const base = ['--name', 'Atlas worker', '--cwd', '/work/atlas']
const parsed = (...more: string[]): SpawnOptions => parseArgs([...base, ...more]) as SpawnOptions

describe('--device on the command line', () => {
  test('a device id or local, PowerShell form too; without it no device at all', () => {
    expect(parsed('--device', 'server-2').device).toBe('server-2')
    expect(parsed('-Device', 'local').device).toBe('local')
    expect(parsed('--device=server-1').device).toBe('server-1')
    expect('device' in parsed()).toBe(false)
  })

  test('a word that is no device id is refused', () => {
    for (const bad of ['Server 2', '@server-2', '', '-x', 'a:b'])
      expect(() => parsed('--device', bad)).toThrow(/--device must be a device id/)
  })

  test('only a new session the board may place takes it', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    for (const [flag, ...rest] of [
      ['--resume', uuid],
      ['--fork', uuid],
      ['--pane', 'w1:p2'],
      ['--session-id', uuid],
      ['--config-dir', '/x'],
      ['--keep-env'],
      ['--workdesk-worker'],
      ['--thread', 'atlas-12'],
    ] as string[][])
      expect(() => parsed('--device', 'server-2', flag as string, ...rest)).toThrow(
        new RegExp(`--device places a new session: give it no ${flag}`),
      )
  })

  test('--trust goes with a placed Claude start (#798); with another agent it is refused', () => {
    expect(parsed('--device', 'server-2', '--trust').trust).toBe(true)
    expect(() => parsed('--device', 'server-2', '--trust', '--agent', 'pi')).toThrow(
      /--device places a new session: give it no --trust/,
    )
  })

  test('the board is asked to pin the start to it; without it the request is as before', () => {
    const facts = { cwd: '/work/atlas', message: '', workspace: { id: 'w1' } }
    expect(launchBody(parsed('--device', 'server-2'), facts).pin).toEqual({ device: 'server-2' })
    expect(launchBody(parsed(), facts)).toEqual({
      name: 'Atlas worker',
      cwd: '/work/atlas',
      message: '',
      workspace: { id: 'w1' },
      byHand: false,
    })
  })
})

describe('the device as the board lists it', () => {
  const devices = [
    { id: 'local', title: 'This computer', selfId: 'server-2', link: null },
    { id: 'laptop', title: 'Laptop', link: { state: 'online' } },
    { id: 'server-1', title: 'Server 1', link: { state: 'offline' } },
    { id: 'old', title: 'Old', link: { state: 'online' }, revoked: { told: true, kept: false } },
  ]
  test('local and the master’s own id are this computer; an online device is itself', () => {
    expect(pinnedDevice(devices, 'local')).toBe('local')
    expect(pinnedDevice(devices, 'server-2')).toBe('local')
    expect(pinnedDevice(devices, 'laptop')).toBe('laptop')
  })
  test('unknown, offline or revoked: a clear refusal', () => {
    expect(() => pinnedDevice(devices, 'server-9')).toThrow(
      "--device server-9: the board has no such device (it has server-2, laptop, server-1, old; local is the board's own computer)",
    )
    expect(() => pinnedDevice(devices, 'server-1')).toThrow(
      '--device server-1: the device is offline, so the start cannot go there now',
    )
    expect(() => pinnedDevice(devices, 'old')).toThrow('--device old: the device was taken off the board')
    expect(() => pinnedDevice(undefined, 'laptop')).toThrow('--device laptop: the board has no such device')
  })
})

describe('the call a node sends its master', () => {
  const call: SpawnCall = {
    name: 'Atlas worker',
    cwd: '/home/anna/work/atlas',
    message: 'Fix the parser.\nThen report.',
    timeoutSec: 120,
    workspace: 'Atlas',
    profile: 'default',
    device: 'server-2',
    model: 'opus',
    facts: {
      checkout: {
        url: 'https://example.test/acme/atlas.git',
        clean: true,
        headPushed: true,
        branch: 'main',
        subdir: '',
      },
      identity: { name: 'Anna', email: 'anna@example.test' },
      localPath: null,
    },
  }
  test('read back as sent; a folder not on the node has no facts', () => {
    expect(spawnCallOf(spawnCallArgv(call))).toEqual(call)
    const away = { ...call, facts: null }
    expect(spawnCallOf(spawnCallArgv(away))).toEqual(away)
  })
  test('anything else is no call', () => {
    const word = (v: unknown) => [JSON.stringify(v)]
    expect(spawnCallOf([])).toBeNull()
    expect(spawnCallOf(['{'])).toBeNull()
    expect(spawnCallOf([...spawnCallArgv(call), 'more'])).toBeNull()
    expect(spawnCallOf(word({ ...call, device: 'Server 2' }))).toBeNull()
    expect(spawnCallOf(word({ ...call, name: '' }))).toBeNull()
    expect(spawnCallOf(word({ ...call, agent: 'vim' }))).toBeNull()
    expect(spawnCallOf(word({ ...call, timeoutSec: -1 }))).toBeNull()
    expect(spawnCallOf(word({ ...call, facts: { ...call.facts, checkout: { clean: 'yes' } } }))).toBeNull()
    expect(spawnCallOf(word({ ...call, facts: { ...call.facts, identity: { name: 'x' } } }))).toBeNull()
    expect(spawnCallOf(word({ ...call, cwd: 'a\u0007b' }))).toBeNull()
  })
  test('the master takes it, and a call sent again is the same start', () => {
    expect(UPLINK_COMMANDS.has('spawn')).toBe(true)
    expect(isRememberedCall('spawn', ['{}'])).toBe(true)
  })
  test('a session placed on this very node is printed as one of its own herdr; others as the master wrote them', () => {
    const sid = '5d0c6a1e-1111-4222-8333-444455556666'
    const names = (pane: string) => (pane === 'w2:p4' ? 'atlas-worker' : pane)
    expect(
      nodeSideLine(
        `pane=@laptop:w2:p4 name=Atlas worker agent=@laptop:${sid} device=laptop session=${sid}`,
        'laptop',
        names,
      ),
    ).toBe(`pane=w2:p4 name=Atlas worker agent=atlas-worker device=laptop session=${sid}`)
    const there = `pane=@server-1:w9:p1 name=Atlas worker agent=@server-1:${sid} device=server-1 session=${sid}`
    expect(nodeSideLine(there, 'laptop', names)).toBe(there)
    expect(nodeSideLine('queued=abcd1234 name=Atlas worker waiting=server-1:sessions', 'laptop', names)).toBe(
      'queued=abcd1234 name=Atlas worker waiting=server-1:sessions',
    )
  })
})
