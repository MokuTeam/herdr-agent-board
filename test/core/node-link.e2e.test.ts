// The node's install on the fake root, the guards around a run: the link step's checks of sshd
// (root's settings unchanged, the fence in force) rolling back to what was there, one run at a
// time under the lock, and a check that fails on a tool too old.
import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { exists, sh } from '../support/fake-root.ts'
import { nodeServer, stepsOf } from '../support/node-root.ts'

test.skipIf(!sh)(
  "the link step's checks: a fence that would change root's sshd, or not hold, rolls back to the fence before",
  () => {
    const s = nodeServer()
    expect(s.apply({ only: ['user', 'link'] }).result).toBe('applied')
    const etc = s.root.etc()
    const passwd = s.root.passwd()
    // another port: the fence and the key are written anew, and root's settings would change
    const leak = s.apply({ only: ['user', 'link'], over: { port: 12431 }, env: { LINK_LEAK: '1' } })
    expect(leak.result).toBe('rolled-back')
    expect(leak.said.join('\n')).toContain("the fence would change sshd's settings for root or the admin")
    expect(s.root.etc()).toEqual(etc)
    expect(s.root.passwd()).toBe(passwd)
    // an AllowUsers that leaves the link user out, on a server with nothing of the board's
    const fresh = nodeServer()
    const etc0 = fresh.root.etc()
    const passwd0 = fresh.root.passwd()
    const out = fresh.apply({ only: ['user', 'link'], env: { LINK_ALLOWUSERS: 'admin' } })
    expect(out.result).toBe('rolled-back')
    expect(out.said.join('\n')).toContain('allowusers leaves agent-board-link out')
    expect(fresh.root.etc()).toEqual(etc0)
    expect(fresh.root.passwd()).toBe(passwd0)
  },
  120_000,
)

test.skipIf(!sh)(
  'one run at a time: Look and Apply see the lock held, and nothing changes',
  async () => {
    const s = nodeServer()
    writeFileSync(s.root.path('/run/agent-board-node.lock'), '')
    const { nodeLookScript, nodePlan, nodeRunScript, readNodeLook, readNodeRun } = await import(
      '../../src/core/node-plan.ts'
    )
    const f = readNodeLook(s.root.run(nodeLookScript({ port: 12430 }), { FLOCK_BUSY: '1' }).lines)
    expect(f?.busy).toBe(true)
    const free = s.look()
    const p = nodePlan(free, s.wanted())
    if (!p.ok) throw new Error('refused')
    const etc = s.root.etc()
    const run = readNodeRun(
      s.root.run(nodeRunScript(p.plan, { id: 'busy-1', at: '2026-11-21T10:00:00Z' }), { FLOCK_BUSY: '1' }).lines,
    )
    expect(run.result).toBe('busy')
    expect(run.steps).toEqual([])
    expect(s.root.etc()).toEqual(etc)
  },
  60_000,
)

test.skipIf(!sh)(
  'the packages tick runs apt; a herdr older than 0.9.5 fails its check and rolls back',
  () => {
    const s = nodeServer()
    const etc = s.root.etc()
    const run = s.apply({
      only: ['user', 'packages', 'herdr'],
      over: { packages: true },
      env: { FAKE_HERDR_VERSION: '0.9.4' },
    })
    expect(run.result).toBe('rolled-back')
    expect(stepsOf(run)).toEqual(['check ok', 'user ok', 'packages ok', 'herdr fail'])
    const log = s.root.log().split('\n')
    // Ubuntu 24.04, the fake root's system, has gh in its own repositories (#609).
    expect(log).toContain('apt-get install -y -q --no-install-recommends git curl unzip ca-certificates gh')
    expect(s.root.etc()).toEqual(etc)
    expect(exists(s.root.path('/home/agent-board'))).toBe(false)
  },
  120_000,
)
