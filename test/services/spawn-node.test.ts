// spawn-agent on a node (#760), the node's side: the start goes up the uplink with the folder's facts
// and the caller's card; a master that cannot be asked, or that turns it away before anything ran,
// leaves it to this computer (said why) unless --device names another machine; a start the master
// took is never started here as well.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, type SpawnOptions } from '../../src/core/launch/spawn-args.ts'
import { type SpawnCall, spawnCallArgv, spawnCallOf } from '../../src/core/launch/spawn-node.ts'
import type { NodeConfig } from '../../src/core/nodes.ts'
import type { NodeCall, NodeCallAnswer } from '../../src/entrypoints/node-call.ts'
import { type AskMasterDeps, askMaster } from '../../src/services/launch/spawn-node.ts'

const CALLER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SID = '5d0c6a1e-1111-4222-8333-444455556666'
const node = {
  id: 'laptop',
  port: 12430,
  workRoot: '~/work',
  listen: 'loopback',
  tls: false,
  relay: null,
} as NodeConfig
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'spawn-node-'))
  dirs.push(d)
  return d
}
const opts = (cwd: string, ...more: string[]): SpawnOptions =>
  parseArgs(['--name', 'Atlas worker', '--cwd', cwd, '--brief', 'Fix the parser.', ...more]) as SpawnOptions
const facts = { checkout: null, identity: null, localPath: null }

function deps(answer: NodeCallAnswer, board: Record<string, unknown> | null = { items: [card] }) {
  const calls: NodeCall[] = []
  const logs: string[] = []
  const d: AskMasterDeps = {
    profiles: [{ id: 'default', title: 'Default', dir: join(tmpdir(), '.claude'), inherited: true }] as never,
    env: { CLAUDE_CODE_SESSION_ID: CALLER, HERDR_PANE_ID: 'w1:p1' },
    home: tmpdir(),
    call: async body => {
      calls.push(body)
      return answer
    },
    board: async () => board,
    herdrName: async pane => (pane === 'w2:p4' ? 'atlas-worker' : pane),
    log: line => logs.push(line),
    facts: async () => facts,
  }
  return { d, calls, logs }
}
const card = { key: CALLER, session: CALLER, pane: 'w1:p1', workspace: 'Atlas', name: 'Lead', category: 'atlas' }
const answered = (code: number, out: string[] = [], err: string[] = []): NodeCallAnswer => ({
  state: 'answered',
  code,
  out,
  err,
})

describe('a node’s spawn-agent asks its master (#760)', () => {
  test('the start goes up as the call spawn, with the caller, the folder’s facts and --device', async () => {
    const cwd = folder()
    const line = `pane=@server-2:w5:p1 name=Atlas worker agent=atlas device=server-2 session=${SID}`
    const { d, calls } = deps(answered(0, [line]))
    expect(await askMaster(opts(cwd, '--device', 'server-2', '--model', 'opus'), node, d)).toBe(line)
    expect(calls.length).toBe(1)
    const c = calls[0] as NodeCall
    expect([c.cmd, c.session, c.lane, c.files]).toEqual(['spawn', CALLER, 'atlas', []])
    expect(spawnCallOf(c.argv)).toEqual({
      name: 'Atlas worker',
      cwd,
      message: 'Fix the parser.',
      timeoutSec: 120,
      workspace: 'Atlas',
      facts,
      model: 'opus',
      profile: 'default',
      device: 'server-2',
    } satisfies SpawnCall)
  })

  test('a session placed back on this node prints as one of its own herdr', async () => {
    const { d } = deps(
      answered(0, [`pane=@laptop:w2:p4 name=Atlas worker agent=@laptop:${SID} device=laptop session=${SID}`]),
    )
    expect(await askMaster(opts(folder()), node, d)).toBe(
      `pane=w2:p4 name=Atlas worker agent=atlas-worker device=laptop session=${SID}`,
    )
  })

  test('without --device: no master to ask, or one that did not place it, and it starts here, saying why', async () => {
    for (const [answer, why] of [
      [{ state: 'unreachable' }, "the board's computer is not reachable"],
      [null, 'the board does not run on this computer'],
      [
        answered(126, [], ["board spawn is not taken from a node: run it on the board's computer"]),
        'does not place starts from a node yet',
      ],
      [
        answered(3, [], ['No device can take it: server-1 is paused']),
        'did not place it (No device can take it: server-1 is paused)',
      ],
    ] as [NodeCallAnswer, string][]) {
      const { d, logs } = deps(answer)
      expect(await askMaster(opts(folder()), node, d)).toBeNull()
      expect(logs.join('\n')).toContain(why)
      expect(logs.join('\n')).toContain('starting it on this computer')
    }
    const off = deps(answered(0), null)
    expect(await askMaster(opts(folder()), node, off.d)).toBeNull()
    expect(off.calls).toEqual([])
  })

  test('with --device another machine, the same is an error; this node itself still starts here', async () => {
    const away = deps({ state: 'unreachable' })
    await expect(askMaster(opts(folder(), '--device', 'server-2'), node, away.d)).rejects.toThrow(
      "--device server-2: the board's computer is not reachable",
    )
    const refused = deps(answered(3, [], ['--device server-9: the board has no such device']))
    await expect(askMaster(opts(folder(), '--device', 'server-9'), node, refused.d)).rejects.toThrow(
      '--device server-9: the board has no such device',
    )
    const self = deps({ state: 'unreachable' })
    expect(await askMaster(opts(folder(), '--device', 'laptop'), node, self.d)).toBeNull()
  })

  test('a start the master took and that failed is never started here as well', async () => {
    const { d, logs } = deps(answered(1, [], ['on server-1: claude exited']))
    await expect(askMaster(opts(folder()), node, d)).rejects.toThrow('on server-1: claude exited')
    expect(logs).toEqual([])
  })

  test('a folder this computer lacks goes as written only with --device; without it the start here says what is wrong', async () => {
    const missing = join(folder(), 'gone')
    const none = deps(answered(0, ['x']))
    expect(await askMaster(opts(missing), node, none.d)).toBeNull()
    expect(none.calls).toEqual([])
    const there = deps(answered(0, ['pane=@server-2:w1:p1 name=Atlas worker agent=a device=server-2 session=s']))
    await askMaster(opts('/srv/atlas', '--device', 'server-2'), node, there.d)
    expect(spawnCallOf((there.calls[0] as NodeCall).argv)?.cwd).toBe('/srv/atlas')
    expect(spawnCallOf((there.calls[0] as NodeCall).argv)?.facts).toBeNull()
  })

  test('a node with a launcher of its own, or a start with what only this computer has, stays here as before', async () => {
    const own = deps(answered(0, ['x']))
    own.d.ownLauncher = true
    expect(await askMaster(opts(folder()), node, own.d)).toBeNull()
    await expect(askMaster(opts(folder(), '--device', 'server-2'), node, own.d)).rejects.toThrow(
      '--device server-2: the board starts sessions with a launcher of its own (launch.command), which places nothing',
    )
    expect(own.calls).toEqual([])
    const local = deps(answered(0, ['x']))
    expect(await askMaster(opts(folder(), '--workspace', 'w3'), node, local.d)).toBeNull()
    expect(
      await askMaster(
        parseArgs(['--name', 'C', '--cwd', folder(), '--agent', 'codex', '--sandbox', 'read-only']) as SpawnOptions,
        node,
        local.d,
      ),
    ).toBeNull()
    await expect(askMaster(opts(folder(), '--workspace', 'w3', '--device', 'server-2'), node, local.d)).rejects.toThrow(
      "--device server-2: --workspace are this computer's: give them without --device",
    )
    expect(local.calls).toEqual([])
    expect(local.logs).toEqual([])
  })

  test('a session the board does not show starts here', async () => {
    const { d, calls, logs } = deps(answered(0), { items: [] })
    expect(await askMaster(opts(folder()), node, d)).toBeNull()
    expect(calls).toEqual([])
    expect(logs[0]).toContain('this session is not on the board')
  })

  test('--trust goes up in the call as trust: true; a start without it sends a call with no trust key (#798)', async () => {
    const cwd = folder()
    const line = `pane=@server-2:w5:p1 name=Atlas worker agent=atlas device=server-2 session=${SID}`
    const trusted = deps(answered(0, [line]))
    expect(await askMaster(opts(cwd, '--trust'), node, trusted.d)).toBe(line)
    expect(spawnCallOf((trusted.calls[0] as NodeCall).argv)).toEqual({
      name: 'Atlas worker',
      cwd,
      message: 'Fix the parser.',
      timeoutSec: 120,
      workspace: 'Atlas',
      facts,
      profile: 'default',
      trust: true,
    } satisfies SpawnCall)
    // With --device the same: trust rides with the machine named.
    const pinned = deps(answered(0, [line]))
    await askMaster(opts(cwd, '--trust', '--device', 'server-2'), node, pinned.d)
    expect(spawnCallOf((pinned.calls[0] as NodeCall).argv)).toMatchObject({ device: 'server-2', trust: true })
    // Without it the call is the one it was before: no trust key in what goes up the uplink.
    const plain = deps(answered(0, [line]))
    await askMaster(opts(cwd), node, plain.d)
    const sent = JSON.parse((plain.calls[0] as NodeCall).argv[0] ?? '{}') as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['cwd', 'facts', 'message', 'name', 'profile', 'timeoutSec', 'workspace'])
    expect(spawnCallOf((plain.calls[0] as NodeCall).argv)).not.toHaveProperty('trust')
  })

  test('a start with --trust that the master turned away or could not place still starts here, asking nothing more of it (#798)', async () => {
    const turned = deps(answered(3, [], ['No device can take it: server-1 is paused']))
    expect(await askMaster(opts(folder(), '--trust'), node, turned.d)).toBeNull()
    expect(turned.calls.length).toBe(1)
    expect(spawnCallOf((turned.calls[0] as NodeCall).argv)?.trust).toBe(true)
    expect(turned.logs.join('\n')).toContain('starting it on this computer')
    const unreachable = deps({ state: 'unreachable' })
    expect(await askMaster(opts(folder(), '--trust'), node, unreachable.d)).toBeNull()
    await expect(
      askMaster(opts(folder(), '--trust', '--device', 'server-2'), node, deps({ state: 'unreachable' }).d),
    ).rejects.toThrow("--device server-2: the board's computer is not reachable")
  })
})

describe('the call a node sends its master, trust (#798)', () => {
  const base: SpawnCall = {
    name: 'Atlas worker',
    cwd: '/home/anna/work/atlas',
    message: 'Fix the parser.',
    timeoutSec: 120,
    workspace: 'Atlas',
    facts,
  }
  const read = (more: Record<string, unknown>) => spawnCallOf([JSON.stringify({ ...base, ...more })])

  test('trust: true is kept; a call without it reads back with no trust key', () => {
    expect(read({ trust: true })).toEqual({ ...base, trust: true })
    const plain = read({})
    expect(plain).toEqual(base)
    expect(plain).not.toHaveProperty('trust')
    expect(spawnCallOf(spawnCallArgv({ ...base, trust: true }))).toEqual({ ...base, trust: true })
  })

  test('a trust that is there and is not true is no call: false, a string, a number, null, an object', () => {
    for (const trust of [false, 'true', 'yes', 1, 0, null, {}, []])
      expect(read({ trust }), JSON.stringify(trust)).toBeNull()
    // The rest of the call is read as before.
    expect(read({ name: '' })).toBeNull()
    expect(read({ device: 'laptop', profile: 'default', model: 'opus' })).toEqual({
      ...base,
      device: 'laptop',
      profile: 'default',
      model: 'opus',
    })
  })

  test('--lane rides in SpawnCall and rejects bad lane ids (#903)', async () => {
    const line = `pane=@server-2:w5:p1 name=Atlas worker agent=atlas device=server-2 session=${SID}`
    const laned = deps(answered(0, [line]))
    expect(await askMaster(opts(folder(), '--lane', 'agent-board'), node, laned.d)).toBe(line)
    expect(spawnCallOf((laned.calls[0] as NodeCall).argv)).toMatchObject({ lane: 'agent-board' })
    expect(read({ lane: 'agent-board' })).toEqual({ ...base, lane: 'agent-board' })
    expect(read({ lane: '-bad' })).toBeNull()
    expect(read({ lane: 123 })).toBeNull()
  })
})
