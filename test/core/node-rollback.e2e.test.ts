// The node's install on the fake root when something goes wrong: a failed step rolls back every
// step that ran, newest first, and leaves the server as it was (an earlier setup and its record
// too); config.json is merged into and never replaced when it does not parse; an admin connection
// that drops does not stop a run.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { exists, sh } from '../support/fake-root.ts'
import { nodeServer, stepsOf } from '../support/node-root.ts'

const CONFIG = '/home/agent-board/.config/herdr/plugins/config/agent-board/config.json'

test.skipIf(!sh)(
  'a failed step rolls back what ran: the server is as it was before Apply',
  () => {
    // no door answers: the last step fails, so every step's undo runs
    const s = nodeServer({ hello: false })
    const etc = s.root.etc()
    const passwd = s.root.passwd()
    const run = s.apply({ waitS: 2 })
    expect(run.result).toBe('rolled-back')
    expect(run.steps.at(-1)).toEqual({ id: 'hello', state: 'fail' })
    expect(run.undone).toEqual(
      ['link', 'unit', 'config', 'plugin', 'claude', 'herdr', 'bun', 'profile', 'linger', 'slice', 'user'].map(id => ({
        id,
        ok: true,
      })),
    )
    expect(run.said.join('\n')).toContain("the node's board did not answer on 127.0.0.1:12430 as server-1 within 2 s")
    expect(s.root.etc()).toEqual(etc)
    expect(s.root.passwd()).toBe(passwd)
    expect(s.root.home()).toEqual({})
    expect(exists(s.root.path('/home/agent-board'))).toBe(false)
    expect(exists(s.root.path('/var/lib/systemd/linger/agent-board'))).toBe(false)
    expect(exists(s.root.path('/etc/agent-board-node'))).toBe(false)
    const log = s.root.log().split('\n')
    for (const line of [
      'userdel agent-board-link',
      'userdel agent-board',
      'loginctl disable-linger agent-board',
      'systemctl --user disable --now herdr.service',
    ])
      expect(log).toContain(line)
  },
  240_000,
)

test.skipIf(!sh)(
  'herdr that runs is never stopped by a rollback: its unit file goes back, herdr runs on (#509)',
  () => {
    const s = nodeServer({ hello: false })
    expect(s.apply({ only: ['user', 'linger', 'unit'] }).result).toBe('applied')
    expect(exists(s.root.path('/state/user-active'))).toBe(true)
    // the owner's own unit, herdr running; the door does not answer, so the run rolls back
    const unit = s.root.path('/home/agent-board/.config/systemd/user/herdr.service')
    const mine = `${readFileSync(unit, 'utf8')}# mine\n`
    writeFileSync(unit, mine)
    const before = s.root.log().length
    const run = s.apply({ only: ['user', 'linger', 'unit', 'hello'], waitS: 2 })
    expect(run.result).toBe('rolled-back')
    expect(stepsOf(run)).toEqual(['check ok', 'user skip', 'linger skip', 'unit ok', 'hello fail'])
    expect(run.undone).toEqual([{ id: 'unit', ok: true }])
    expect(readFileSync(unit, 'utf8')).toBe(mine)
    expect(exists(s.root.path('/state/user-active'))).toBe(true)
    const after = s.root.log().slice(before)
    for (const word of ['disable --now', 'enable --now', 'restart', '--user stop', '--user start'])
      expect([word, after.includes(word)]).toEqual([word, false])
  },
  240_000,
)

test.skipIf(!sh)(
  'a failure on a server set up before leaves that setup and its record byte for byte',
  () => {
    const s = nodeServer()
    const first = s.apply({ only: ['user', 'slice', 'linger'] })
    expect(first.result).toBe('applied')
    const etc = s.root.etc()
    const home = s.root.home()
    const passwd = s.root.passwd()
    // Claude Code's installer fails: the steps that ran this time are undone, the earlier ones stay
    const run = s.apply({ only: ['user', 'slice', 'linger', 'profile', 'claude'], env: { FAKE_CLAUDE_FAIL: '1' } })
    expect(run.result).toBe('rolled-back')
    expect(stepsOf(run)).toEqual(['check ok', 'user skip', 'slice skip', 'linger skip', 'profile ok', 'claude fail'])
    expect(run.undone).toEqual([
      { id: 'claude', ok: true },
      { id: 'profile', ok: true },
    ])
    expect(s.root.etc()).toEqual(etc)
    expect(s.root.home()).toEqual(home)
    expect(s.root.passwd()).toBe(passwd)
  },
  120_000,
)

test.skipIf(!sh)(
  'config.json is merged into, and one that does not parse is left as it is',
  () => {
    const s = nodeServer()
    expect(s.apply({ only: ['user', 'bun'] }).result).toBe('applied')
    mkdirSync(s.root.path(CONFIG.slice(0, CONFIG.lastIndexOf('/'))), { recursive: true })
    writeFileSync(s.root.path(CONFIG), '{"language":"ru","node":{"workRoot":"~/w"}}\n')
    const merged = s.apply({ only: ['user', 'bun', 'config'] })
    expect(merged.result).toBe('applied')
    expect(JSON.parse(readFileSync(s.root.path(CONFIG), 'utf8'))).toEqual({
      language: 'ru',
      node: { workRoot: '~/w', id: 'server-1', port: 12430 },
    })
    writeFileSync(s.root.path(CONFIG), '{"language": "ru",\n')
    const record = readFileSync(s.root.path('/etc/agent-board-node/setup.json'), 'utf8')
    const run = s.apply({ only: ['user', 'bun', 'config'] })
    expect(run.result).toBe('rolled-back')
    expect(run.said.join('\n')).toContain('config.json does not parse: it is left as it is')
    expect(readFileSync(s.root.path(CONFIG), 'utf8')).toBe('{"language": "ru",\n')
    expect(readFileSync(s.root.path('/etc/agent-board-node/setup.json'), 'utf8')).toBe(record)
  },
  120_000,
)

test.skipIf(!sh)(
  'an admin connection that drops mid-run does not stop it: the run ends and records it',
  async () => {
    const s = nodeServer()
    const p = s.look()
    expect(p.user).toBe('none')
    const { nodePlan, nodeRunScript } = await import('../../src/core/node-plan.ts')
    const plan = nodePlan(p, s.wanted())
    if (!plan.ok) throw new Error('refused')
    const steps = plan.plan.steps.filter(x => ['check', 'user', 'slice', 'linger'].includes(x.id))
    await s.root.runCut(nodeRunScript({ ...plan.plan, steps }, { id: 'cut-1', at: '2026-11-21T10:00:00Z' }), 3)
    expect(s.record()?.state).toBe('applied')
    expect(s.record()?.items.map(i => i.kind)).toEqual(['user', 'slice', 'linger'])
  },
  120_000,
)
