// "Add a server"'s pure parts (#509, core/node-setup.ts): the device written into config.json's
// `nodes` (and the section made on a board that has none), taken out after Undo, the device's id
// for a server, the upload's lines, and the packed run, unpacked by the server's own sh.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import {
  cleanScript,
  deviceIdFor,
  deviceIdProblem,
  dropDevice,
  packedRun,
  putDevice,
  readUpload,
  sshLink,
} from '../../src/core/node-setup.ts'
import { nodesConfig } from '../../src/core/nodes.ts'
import { sh } from '../support/fake-root.ts'
import { unpackNodeRun } from '../support/fake-root-prep.ts'

const LINK = sshLink('203.0.113.10', 22, 12430)
const PATH = '/var/tmp/agent-board-node.Ab3dE9xQ/plugin.tar'
const SHA = 'a'.repeat(64)

describe('the device in config.json', () => {
  test("a board without nodes gets the section: this computer's id, the device first and local after, no lane, a start by hand here when all is full", () => {
    const nodes: Record<string, unknown> = {}
    expect(putDevice(nodes, false, { id: 'server-1', link: LINK, selfId: 'laptop' })).toBe(true)
    expect(nodes).toEqual({
      id: 'laptop',
      order: ['server-1', 'local'],
      whenFull: 'local',
      devices: {
        'server-1': { link: { kind: 'ssh', host: '203.0.113.10', sshPort: 22, user: 'agent-board-link', port: 12430 } },
      },
    })
    // the section reads as one: no problem, the device has its link, no lane leaves
    const cfg = nodesConfig(nodes, 'laptop')
    expect(cfg?.problems).toEqual([])
    expect(cfg?.order).toEqual(['server-1', 'local'])
    expect(cfg?.devices['server-1']?.link).toEqual(LINK)
    expect(cfg?.lanes).toEqual([])
    expect(cfg?.whenFull).toBe('local')
  })

  test('a section already there keeps all of its own: the device goes in before local; one already there gets the link and loses its revocation', () => {
    const nodes: Record<string, unknown> = {
      id: 'desk',
      order: ['box-9', 'local', 'box-3'],
      lanes: 'all',
      whenFull: 'wait',
      devices: { 'box-9': { link: { kind: 'direct', url: 'http://127.0.0.1:1' }, maxSessions: 2 } },
    }
    expect(putDevice(nodes, true, { id: 'server-1', link: LINK, selfId: 'ignored' })).toBe(true)
    expect(nodes.order).toEqual(['box-9', 'server-1', 'local', 'box-3'])
    expect(nodes.id).toBe('desk')
    expect(nodes.lanes).toBe('all')
    expect(nodes.whenFull).toBe('wait')
    // the same again changes nothing
    const before = JSON.stringify(nodes)
    expect(putDevice(nodes, true, { id: 'server-1', link: LINK, selfId: 'ignored' })).toBe(false)
    expect(JSON.stringify(nodes)).toBe(before)
    // revoked before, with thresholds of the owner's: the link is new, the revocation goes, the rest stays
    const devices = nodes.devices as Record<string, Record<string, unknown>>
    devices['server-1'] = { link: { ...LINK, host: 'old.example.com' }, revoked: true, maxSessions: 1, title: 'Box' }
    expect(putDevice(nodes, true, { id: 'server-1', link: LINK, selfId: 'ignored' })).toBe(true)
    expect(devices['server-1']).toEqual({ link: LINK, maxSessions: 1, title: 'Box' })
    // an order without local: the device last; no order at all: none is made
    const noLocal: Record<string, unknown> = { order: ['box-9'] }
    putDevice(noLocal, true, { id: 'server-1', link: LINK, selfId: 'x' })
    expect(noLocal.order).toEqual(['box-9', 'server-1'])
    const noOrder: Record<string, unknown> = {}
    putDevice(noOrder, true, { id: 'server-1', link: LINK, selfId: 'x' })
    expect(noOrder).toEqual({ devices: { 'server-1': { link: LINK } } })
  })

  test('Undo takes the device and its place in the order out, and nothing else', () => {
    const nodes: Record<string, unknown> = {
      id: 'desk',
      order: ['server-1', 'local'],
      devices: { 'server-1': { link: LINK }, local: { maxSessions: 3 } },
    }
    expect(dropDevice(nodes, 'server-1')).toBe(true)
    expect(nodes).toEqual({ id: 'desk', order: ['local'], devices: { local: { maxSessions: 3 } } })
    expect(dropDevice(nodes, 'server-1')).toBe(false)
  })
})

describe("the device's id", () => {
  const devices = { 'box-9': { link: { kind: 'ssh', host: '203.0.113.10', sshPort: 2222 } }, local: {} }
  test("the owner's first; then this master's device for the host; then the node there, the record, the server's name", () => {
    const base = { host: '203.0.113.10', sshPort: 22, devices }
    expect(deviceIdFor({ ...base, asked: 'mine' })).toBe('mine')
    expect(deviceIdFor({ ...base, sshPort: 2222 })).toBe('box-9')
    expect(deviceIdFor(base)).toBeNull()
    const server = { nodeId: 'server-1', recordId: 'old', hostname: 'vps-77.example.net' }
    expect(deviceIdFor({ ...base, server })).toBe('server-1')
    expect(deviceIdFor({ ...base, server: { ...server, nodeId: null } })).toBe('old')
    expect(deviceIdFor({ ...base, server: { nodeId: null, recordId: null, hostname: 'VPS_77.example.net' } })).toBe(
      'vps-77',
    )
    expect(deviceIdFor({ ...base, server: { nodeId: null, recordId: null, hostname: '' } })).toBe('203-0-113-10')
  })

  test("refused: not an id, local, this board's own, another server's device; the same server's is its own", () => {
    const o = { host: '203.0.113.10', sshPort: 2222, selfId: 'laptop', devices }
    expect(deviceIdProblem('Box 9', o)?.key).toBe('node.setup.refuse.id')
    expect(deviceIdProblem('local', o)?.key).toBe('node.setup.refuse.id')
    expect(deviceIdProblem('laptop', o)?.key).toBe('node.setup.refuse.idSelf')
    expect(deviceIdProblem('box-9', { ...o, sshPort: 22 })?.key).toBe('node.setup.refuse.idTaken')
    expect(deviceIdProblem('box-9', o)).toBeNull()
    expect(deviceIdProblem('server-1', o)).toBeNull()
  })
})

describe('the archive and the run on the server', () => {
  test("the upload's lines: its folder under /var/tmp and its sha256, nothing else taken", () => {
    expect(readUpload([`@@path ${PATH}`, `@@sha ${SHA}`])).toEqual({ path: PATH, sha256: SHA })
    expect(readUpload([`@@path /home/admin/plugin.tar`, `@@sha ${SHA}`])).toBeNull()
    expect(readUpload([`@@path /var/tmp/agent-board-node.x/../../etc/plugin.tar`, `@@sha ${SHA}`])).toBeNull()
    expect(readUpload([`@@path ${PATH}`, `@@sha ${'0'.repeat(63)}`])).toBeNull()
    expect(cleanScript(PATH)).toContain("rm -rf '/var/tmp/agent-board-node.Ab3dE9xQ'")
    expect(() => cleanScript('/var/tmp')).toThrow()
  })

  test('a packed run is unpacked by sh and runs as it was written, its exit code its own', () => {
    const script = 'echo \'it ran\'\necho "$1-$#"\nexit 7\n'
    const packed = packedRun('apply', script, t => gzipSync(t).toString('base64'))
    expect(packed.split('\n')[0]).toBe('# agent-board: node apply')
    expect(unpackNodeRun(packed)).toBe(script)
    const r = spawnSync(sh as string, ['-c', packed], { encoding: 'utf8' })
    expect(r.stdout).toBe('it ran\n-0\n')
    expect(r.status).toBe(7)
    // a payload that does not unpack: said, nothing run
    const torn = packedRun('apply', script, () => 'bm90IGd6aXA=')
    const t = spawnSync(sh as string, ['-c', torn], { encoding: 'utf8' })
    expect(t.stdout).toContain('@@result unchanged')
    expect(t.status).toBe(3)
  })
})
