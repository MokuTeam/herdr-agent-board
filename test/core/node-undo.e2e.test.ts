// Undo of the node's install on the fake root: it removes what the record lists and nothing else
// (other users, other drop-ins and units, ~/work unless ticked), after a run cut short too, and a
// second Undo finds nothing to do. Apply here runs only the steps whose parts the record lists, so
// the record holds every kind of item without the installers' time.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { nodePlan, nodeRunScript, nodeUndoPlan, readNodeRun } from '../../src/core/node-plan.ts'
import { exists, sh } from '../support/fake-root.ts'
import { nodeServer, stepsOf } from '../support/node-root.ts'

const MAKES = ['user', 'slice', 'linger', 'unit', 'link']
const TUNNEL_DROP_IN = "# agent-board: the tunnel's fence\nMatch User agent-board-tunnel\n    ForceCommand /bin/false\n"

/** A server with things of others' beside the board's: a user, a unit, the tunnel's drop-in. */
function withOthers() {
  const s = nodeServer()
  writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board.conf'), TUNNEL_DROP_IN)
  mkdirSync(s.root.path('/etc/systemd/system'), { recursive: true })
  writeFileSync(s.root.path('/etc/systemd/system/caddy.service'), '[Service]\nExecStart=/usr/bin/caddy run\n')
  writeFileSync(
    s.root.path('/state/passwd'),
    `${s.root.passwd()}tunnel:x:901:901:agent-board tunnel:/nonexistent:/usr/sbin/nologin\n`,
  )
  return s
}

test.skipIf(!sh)(
  'Undo removes what the record lists and nothing else; ~/work stays, given to root',
  () => {
    const s = withOthers()
    const etc = s.root.etc()
    const passwd = s.root.passwd()
    expect(s.apply({ only: MAKES }).result).toBe('applied')
    expect(s.record()?.items.map(i => (i.kind === 'user' ? `user ${i.name}` : i.kind))).toEqual([
      'user agent-board',
      'slice',
      'linger',
      'unit',
      'user agent-board-link',
      'keysdir',
      'keys',
      'fence',
    ])
    mkdirSync(s.root.path('/home/agent-board/work/atlas'), { recursive: true })
    writeFileSync(s.root.path('/home/agent-board/work/atlas/notes.md'), 'the work\n')
    const run = s.undo(false)
    expect(run.result).toBe('undone')
    expect(stepsOf(run)).toEqual([
      'check ok',
      'unit ok',
      'linger ok',
      'fence ok',
      'keys ok',
      'link-user ok',
      'slice ok',
      'user ok',
    ])
    expect(run.kept).toBe(`${s.root.R}/home/agent-board/work`)
    expect(s.root.etc()).toEqual(etc)
    expect(s.root.passwd()).toBe(passwd)
    expect(s.root.home()).toEqual({ '/home/agent-board/work/atlas/notes.md': 'the work\n' })
    expect(exists(s.root.path('/var/lib/systemd/linger/agent-board'))).toBe(false)
    expect(exists(s.root.path('/etc/agent-board-node'))).toBe(false)
    const log = s.root.log().split('\n')
    for (const line of [
      'systemctl --user disable --now herdr.service',
      'loginctl disable-linger agent-board',
      'systemctl try-reload-or-restart ssh',
      'userdel agent-board-link',
      'userdel agent-board',
      `chown -R -h root:root ${s.root.R}/home/agent-board`,
    ])
      expect(log).toContain(line)
    // the kept work is no new user's: Apply is refused until it is moved away
    const back = nodePlan(s.look(), s.wanted())
    expect(back.ok ? [] : back.why.map(t => t.key)).toEqual(['node.refuse.homeLeft'])
    // nothing left to undo
    const again = nodeRunScript(
      nodeUndoPlan(
        {
          v: 1,
          run: 'r',
          at: '2026-11-21T10:00:00Z',
          state: 'applied',
          node: { id: 'server-1', port: 12430 },
          items: [],
        },
        { work: false },
      ),
      { id: 'u2', at: '2026-11-21T12:00:00Z' },
    )
    expect(readNodeRun(s.root.run(again).lines).result).toBe('none')
  },
  120_000,
)

test.skipIf(!sh)(
  'Undo with the work ticked removes the home whole',
  () => {
    const s = nodeServer()
    expect(s.apply({ only: ['user', 'linger'] }).result).toBe('applied')
    mkdirSync(s.root.path('/home/agent-board/work'), { recursive: true })
    writeFileSync(s.root.path('/home/agent-board/work/x'), 'x\n')
    const run = s.undo(true)
    expect(run.result).toBe('undone')
    expect(run.kept).toBeNull()
    expect(exists(s.root.path('/home/agent-board'))).toBe(false)
  },
  120_000,
)

test.skipIf(!sh)(
  'after a run cut short: Look sends to Undo, and Undo removes what the record names, made or not',
  () => {
    const s = nodeServer()
    expect(s.apply({ only: ['user', 'slice', 'linger'] }).result).toBe('applied')
    // as a run killed while it made the unit leaves the record: running, the unit named, not written
    const path = s.root.path('/etc/agent-board-node/setup.json')
    const cut = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, `${JSON.stringify({ ...cut, state: 'running', items: [...cut.items, { kind: 'unit' }] })}\n`)
    const f = s.look()
    const p = nodePlan(f, s.wanted())
    expect(p.ok ? [] : p.why.map(t => t.key)).toEqual(['node.refuse.interrupted'])
    const run = s.undo(false)
    expect(run.result).toBe('undone')
    expect(stepsOf(run)).toEqual(['check ok', 'unit ok', 'linger ok', 'slice ok', 'user ok'])
    expect(s.root.passwd()).not.toContain('agent-board')
    expect(exists(s.root.path('/etc/agent-board-node'))).toBe(false)
  },
  120_000,
)

test.skipIf(!sh)(
  "a node user that was there before is not the board's to remove: it and its home stay",
  () => {
    const s = nodeServer()
    mkdirSync(s.root.path('/home/agent-board'), { recursive: true })
    writeFileSync(s.root.path('/home/agent-board/.bashrc'), '# mine\n')
    writeFileSync(
      s.root.path('/state/passwd'),
      `${s.root.passwd()}agent-board:x:1001:1001:agent-board node:${s.root.R}/home/agent-board:/bin/bash\n`,
    )
    const run = s.apply({ only: ['user', 'slice'] })
    expect(stepsOf(run)).toEqual(['check ok', 'user skip', 'slice ok'])
    expect(s.record()?.items).toEqual([{ kind: 'slice', uid: 1001 }])
    expect(s.undo(false).result).toBe('undone')
    expect(s.root.passwd()).toContain('agent-board:x:1001')
    expect(s.root.home()).toEqual({ '/home/agent-board/.bashrc': '# mine\n' })
    expect(exists(s.root.path('/etc/systemd/system/user-1001.slice.d/50-agent-board-node.conf'))).toBe(false)
  },
  120_000,
)
