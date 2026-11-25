// The node's install on the fake root (test/support/fake-root.ts): Look on a fresh server, Apply's
// every step with its check, the record it leaves, a second Apply that changes nothing, and the
// other setups' sshd drop-ins kept byte for byte. The rollbacks and Undo are in node-rollback and
// node-undo, so the slow parts of the three run side by side.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { ceilingFor, nodeLookScript, nodePlan, nodeRunScript, nodeUndoPlan } from '../../src/core/node-plan.ts'
import { herdrUnit, linkFence, linkKeysLine, profileBlock, sliceDropIn } from '../../src/core/node-texts.ts'
import { nodeConfig } from '../../src/core/nodes.ts'
import { sh } from '../support/fake-root.ts'
import { LINK_KEY, nodeServer, stepsOf, TOKEN, TOKEN_HASH } from '../support/node-root.ts'

const TUNNEL_DROP_IN = "# agent-board: the tunnel's fence\nMatch User agent-board-tunnel\n    ForceCommand /bin/false\n"
const BACKUP_DROP_IN =
  "# agent-board: sshd's fence for the board's backup user\nMatch User agent-board-backup\n    ForceCommand /etc/agent-board-backup/drop\nMatch all\n"

test.skipIf(!sh)(
  'every script parses as POSIX sh',
  () => {
    const s = nodeServer()
    const f = s.look()
    const dir = mkdtempSync(join(tmpdir(), 'board-node-sh-'))
    try {
      const scripts: [string, string][] = [['look', nodeLookScript({ port: 12430, linkKey: LINK_KEY })]]
      for (const [name, over, facts] of [
        ['apply', {}, f],
        ['apply-packages', { packages: true }, f],
        ['apply-copy', {}, { ...f, serverBun: { path: '/usr/local/bin/bun', version: '1.4.5' } }],
      ] as const) {
        const p = nodePlan(facts, s.wanted(over))
        if (!p.ok) throw new Error('refused')
        scripts.push([name, nodeRunScript(p.plan, { id: 'r', at: '2026-11-21T10:00:00Z' })])
      }
      const all = {
        v: 1 as const,
        run: 'r',
        at: '2026-11-21T10:00:00Z',
        state: 'applied' as const,
        node: { id: 'server-1', port: 12430 },
        items: [
          { kind: 'user' as const, name: 'agent-board' as const },
          { kind: 'linger' as const },
          { kind: 'slice' as const, uid: 1001 },
          { kind: 'unit' as const },
          { kind: 'keysdir' as const },
          { kind: 'keys' as const },
          { kind: 'fence' as const },
          { kind: 'user' as const, name: 'agent-board-link' as const },
        ],
      }
      for (const work of [false, true])
        scripts.push([
          `undo-${work}`,
          nodeRunScript(nodeUndoPlan(all, { work }), { id: 'u', at: '2026-11-21T10:00:00Z' }),
        ])
      for (const [name, text] of scripts) {
        const file = join(dir, `${name}.sh`)
        writeFileSync(file, text)
        const r = spawnSync(sh as string, ['-n', file], { encoding: 'utf8' })
        expect([name, r.status, r.stderr]).toEqual([name, 0, ''])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!sh)(
  'Look on a fresh server reads it as it is, and changes nothing',
  () => {
    const s = nodeServer()
    writeFileSync(
      s.root.path('/state/listen'),
      'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=801,fd=3))\nLISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("caddy",pid=900,fd=7))\n',
    )
    const before = s.root.etc()
    const f = s.look()
    expect(f).toMatchObject({
      os: { id: 'ubuntu', version: '24.04', pretty: 'Ubuntu 24.04.1 LTS' },
      memTotalMb: 7957,
      memAvailableMb: 7128,
      systemd: true,
      sudo: 'root',
      user: 'none',
      linkUser: 'none',
      slice: false,
      unit: false,
      linger: false,
      keysDir: false,
      keys: 'none',
      fence: 'none',
      include: true,
      sshdNow: 'ok',
      record: null,
      listening: [
        { port: 22, name: 'sshd' },
        { port: 8080, name: 'caddy' },
      ],
      bun: null,
      herdr: null,
      claude: null,
    })
    expect(f.has).toEqual(expect.arrayContaining(['curl', 'tar', 'runuser', 'loginctl', 'useradd']))
    expect(ceilingFor(f)).toEqual({
      memoryMaxMb: 4774,
      memoryHighMb: 3819,
      swapMaxMb: 512,
      cpuWeight: 50,
      tasksMax: 3000,
    })
    expect(s.root.etc()).toEqual(before)
    // sshd -t only reads
    expect(s.root.log()).toBe('sshd -t\n')
  },
  60_000,
)

describe.skipIf(!sh)('Apply on the fake root', () => {
  test('every step runs with its check, the record lists what it made, and a second Apply changes nothing', () => {
    const s = nodeServer()
    const R = s.root.R
    // the other setups' drop-ins, which the node's install never touches
    writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board.conf'), TUNNEL_DROP_IN)
    writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board-backup.conf'), BACKUP_DROP_IN)
    const before = s.root.etc()
    const w = s.wanted()
    const run = s.apply()
    expect(run.result).toBe('applied')
    expect(stepsOf(run)).toEqual(
      [
        'check',
        'user',
        'slice',
        'linger',
        'profile',
        'bun',
        'herdr',
        'claude',
        'plugin',
        'config',
        'install',
        'unit',
        'link',
        'hello',
      ].map(id => `${id} ok`),
    )
    const etc = s.root.etc()
    // what the run added under /etc, and nothing else changed there
    const added = Object.keys(etc)
      .filter(k => !(k in before))
      .sort()
    expect(added).toEqual([
      '/etc/agent-board-node/setup.json',
      '/etc/ssh/authorized_keys/agent-board-link',
      '/etc/ssh/sshd_config.d/00-agent-board-node.conf',
      '/etc/systemd/system/user-900.slice.d/50-agent-board-node.conf',
    ])
    for (const [k, v] of Object.entries(before)) expect([k, etc[k]]).toEqual([k, v])
    // the texts as node-texts.ts writes them, the fake root's paths in place of the server's
    const onRoot = (text: string): string => text.replaceAll('/etc/', `${R}/etc/`)
    expect(etc['/etc/systemd/system/user-900.slice.d/50-agent-board-node.conf']).toBe(sliceDropIn(w.ceiling))
    expect(etc['/etc/ssh/sshd_config.d/00-agent-board-node.conf']).toBe(onRoot(linkFence(12430)))
    expect(etc['/etc/ssh/authorized_keys/agent-board-link']).toBe(`${linkKeysLine(LINK_KEY, 12430)}\n`)
    expect(s.record()).toEqual({
      v: 1,
      run: 'run-1',
      at: '2026-11-21T10:00:00Z',
      state: 'applied',
      node: { id: 'server-1', port: 12430 },
      items: [
        { kind: 'user', name: 'agent-board' },
        { kind: 'slice', uid: 900 },
        { kind: 'linger' },
        { kind: 'unit' },
        { kind: 'user', name: 'agent-board-link' },
        { kind: 'keysdir' },
        { kind: 'keys' },
        { kind: 'fence' },
      ],
    })
    // the node user's home, written by that user
    const home = s.root.home()
    expect(home['/home/agent-board/.config/systemd/user/herdr.service']).toBe(herdrUnit())
    expect(home['/home/agent-board/.profile']).toBe(profileBlock())
    expect(JSON.parse(home['/home/agent-board/.config/herdr/plugins/config/agent-board/config.json'] ?? '')).toEqual({
      node: { id: 'server-1', port: 12430 },
    })
    // read by the node's own board as it will read them: its store and its config
    const store = createNodeStore({ dir: s.root.path('/home/agent-board/.local/state/herdr/plugins/agent-board/node') })
    expect(store.list()).toEqual([
      {
        id: 'laptop',
        name: "Ноутбук 'дом' 100%",
        tokenHash: TOKEN_HASH,
        pairedAt: expect.any(Number),
        seenAt: null,
        via: 'install',
      },
    ])
    expect(store.verify(TOKEN)?.id).toBe('laptop')
    expect(store.verify('another token')).toBeNull()
    const config = JSON.parse(home['/home/agent-board/.config/herdr/plugins/config/agent-board/config.json'] ?? '')
    expect(nodeConfig(config.node)).toMatchObject({ id: 'server-1', port: 12430 })
    expect(home['/home/agent-board/agent-board/package.json']).toBe('{"name":"agent-board"}\n')
    expect(home['/home/agent-board/agent-board/.archive-sha256']).toBe(`${w.plugin.sha256}\n`)
    expect(Object.keys(home)).toEqual(
      expect.arrayContaining([
        '/home/agent-board/.bun/bin/bun',
        '/home/agent-board/.local/bin/herdr',
        '/home/agent-board/.local/bin/claude',
      ]),
    )
    const log = s.root.log()
    for (const line of [
      'loginctl enable-linger agent-board',
      'systemctl daemon-reload',
      `curl https://bun.sh/install`,
      'installer bun 1.4.3',
      'bun install --production',
      `herdr plugin link ${R}/home/agent-board/agent-board`,
      'bun src/entrypoints/install.ts',
      'systemctl --user enable herdr.service',
      'systemctl --user start herdr.service',
      'useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment agent-board node link agent-board-link',
      'sshd -t',
      'systemctl try-reload-or-restart ssh',
      'curl http://127.0.0.1:12430/api/hello',
    ])
      expect(log.split('\n')).toContain(line)
    expect(readFileSync(s.root.path('/var/lib/systemd/linger/agent-board'), 'utf8')).toBe('')

    // a second Apply: every step finds its part in place, the record stays byte for byte
    const etc1 = s.root.etc()
    const home1 = s.root.home()
    const logged = log.length
    const again = s.apply()
    expect(again.result).toBe('applied')
    expect(stepsOf(again)).toEqual([
      'check ok',
      ...[
        'user',
        'slice',
        'linger',
        'profile',
        'bun',
        'herdr',
        'claude',
        'plugin',
        'config',
        'install',
        'unit',
        'link',
      ].map(id => `${id} skip`),
      'hello ok',
    ])
    expect(s.root.etc()).toEqual(etc1)
    expect(s.root.home()).toEqual(home1)
    const more = s.root.log().slice(logged)
    for (const changing of [
      'useradd',
      'userdel',
      'loginctl',
      'daemon-reload',
      'try-reload',
      '--user enable',
      '--user start',
      'installer',
      'plugin link',
      'bun install',
    ])
      expect([changing, more.includes(changing)]).toEqual([changing, false])
  }, 240_000)
})

describe.skipIf(!sh)('the plugin step and a git checkout (#793, #795)', () => {
  const HOME = '/home/agent-board'
  test('a plugin folder, a .old or a .new that holds a .git: the step fails in words and every one of them is kept', () => {
    const s = nodeServer()
    expect(s.apply().result).toBe('applied')
    const put = (rel: string, data: string): void => {
      mkdirSync(dirname(s.root.path(`${HOME}/${rel}`)), { recursive: true })
      writeFileSync(s.root.path(`${HOME}/${rel}`), data)
    }
    for (const [d, rel] of [
      ['agent-board', 'agent-board/.git/HEAD'],
      ['agent-board.old', 'agent-board.old/.git/HEAD'],
      ['agent-board.new', 'agent-board.new/.git'],
    ] as const) {
      // the plugin no longer holds the archive the board sends: its step runs again
      rmSync(s.root.path(`${HOME}/agent-board/.archive-sha256`), { force: true })
      put(rel, 'ref')
      put(`${d}/mine.txt`, 'mine')
      const run = s.apply({ only: ['plugin'] })
      expect(stepsOf(run)).toContain('plugin fail')
      expect(run.result).not.toBe('applied')
      expect(run.said.join('\n')).toContain(`${d} holds a git checkout (.git): it is kept`)
      expect(readFileSync(s.root.path(`${HOME}/${rel}`), 'utf8')).toBe('ref')
      expect(readFileSync(s.root.path(`${HOME}/${d}/mine.txt`), 'utf8')).toBe('mine')
      // the plugin's own files are where they were
      expect(readFileSync(s.root.path(`${HOME}/agent-board/package.json`), 'utf8')).toBe('{"name":"agent-board"}\n')
      rmSync(s.root.path(`${HOME}/${d}`), { recursive: true, force: true })
      if (d === 'agent-board') put('agent-board/package.json', '{"name":"agent-board"}\n')
    }
    // with none of them left, the step runs as before and puts the plugin in place
    rmSync(s.root.path(`${HOME}/agent-board/.archive-sha256`), { force: true })
    const again = s.apply({ only: ['plugin'] })
    expect(stepsOf(again)).toContain('plugin ok')
    expect(existsSync(s.root.path(`${HOME}/agent-board/.archive-sha256`))).toBe(true)
  }, 120_000)
})
