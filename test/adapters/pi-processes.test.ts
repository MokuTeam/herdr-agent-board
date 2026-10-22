// pi's processes (#178): pi found in herdr's process-info, the tree it started read from the
// process table, and all of it stopped, pi first; the Claude account folder read from its env.
import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  claudeConfigDirOf,
  descendants,
  type ProcRow,
  type ProcSys,
  piProcessOf,
  realProcSys,
  stopTree,
} from '../../src/adapters/pi-processes.ts'

/** A clock that moves on at once by what is slept. */
function clock() {
  const c = { at: 0 }
  const sleep = async (ms: number): Promise<void> => {
    c.at += ms
  }
  return { c, t: { now: () => c.at, sleep } }
}

/**
 * A process table: `rows`, and each process's reaction to signals. pi (`root`) ends on SIGTERM;
 * `stubborn` ones end only on SIGKILL. A process whose parent ends is handed to pid 1, as on POSIX.
 */
function fakeSys(rows: ProcRow[], o: { stubborn?: number[]; tableFails?: boolean } = {}) {
  const live = new Set(rows.map(r => r.pid))
  const signals: string[] = []
  const sys: ProcSys = {
    async table() {
      if (o.tableFails) throw new Error('ps: not found')
      return rows.filter(r => live.has(r.pid)).map(r => ({ ...r }))
    },
    signal(pid, sig) {
      signals.push(`${sig} ${pid}`)
      if (!live.has(pid)) return false
      if (sig === 'SIGKILL' || !o.stubborn?.includes(pid)) live.delete(pid)
      for (const r of rows) if (r.ppid === pid && !live.has(pid)) r.ppid = 1
      return true
    },
    alive: pid => live.has(pid),
  }
  return { sys, live, signals }
}

// pi 400 with the bridge's claude (401, which runs an MCP server 402) and two MCP servers of its
// own (403 through npx, which runs 404); 500 is another session's.
const TABLE: ProcRow[] = [
  { pid: 1, ppid: 0 },
  { pid: 300, ppid: 1 },
  { pid: 400, ppid: 300 },
  { pid: 401, ppid: 400 },
  { pid: 402, ppid: 401 },
  { pid: 403, ppid: 400 },
  { pid: 404, ppid: 403 },
  { pid: 500, ppid: 300 },
]

test('the tree below pi: its children, theirs, and no other session’s', () => {
  expect(descendants(TABLE, 400)).toEqual([401, 403, 402, 404])
  expect(descendants(TABLE, 404)).toEqual([])
  // A loop in a table read halfway through a change does not hang.
  expect(
    descendants(
      [
        { pid: 2, ppid: 3 },
        { pid: 3, ppid: 2 },
      ],
      2,
    ),
  ).toEqual([3])
})

test('pi stops on SIGTERM, then what it left behind is stopped too, all of it read before pi went', async () => {
  const { sys, live, signals } = fakeSys(structuredClone(TABLE))
  const { t } = clock()
  const r = await stopTree(sys, 400, t)
  expect(r).toEqual({ left: [], tree: [401, 403, 402, 404], table: true })
  expect(signals[0]).toBe('SIGTERM 400')
  expect([...live].sort()).toEqual([1, 300, 500])
})

test('one that ignores SIGTERM gets SIGKILL, pi too after its time', async () => {
  const { sys, live, signals } = fakeSys(structuredClone(TABLE), { stubborn: [400, 404] })
  const { c, t } = clock()
  const r = await stopTree(sys, 400, t, { piExitMs: 15_000, restExitMs: 5000 })
  expect(r.left).toEqual([])
  expect(signals).toContain('SIGKILL 400')
  expect(signals).toContain('SIGKILL 404')
  expect(signals).not.toContain('SIGKILL 401')
  expect(c.at).toBeGreaterThanOrEqual(20_000)
  expect(live.has(500)).toBe(true)
})

test('a process table that cannot be read: only pi is stopped, and that is said', async () => {
  const { sys, live } = fakeSys(structuredClone(TABLE), { tableFails: true })
  const r = await stopTree(sys, 400, clock().t)
  expect(r).toEqual({ left: [], tree: [], table: false })
  expect(live.has(401)).toBe(true)
})

test('pi in herdr’s process-info: the foreground group’s leader that is pi, not the bridge’s claude', () => {
  // As herdr 0.9.5 gives it for a pi started by the board (trimmed).
  const answer = {
    process_info: {
      foreground_process_group_id: 59597,
      foreground_processes: [
        { argv: ['pi', '--model', 'claude-bridge/claude-opus-5-5', '--name', 'x'], name: 'pi', pid: 59597 },
        {
          argv: ['/home/u/.pi/agent/git/pi-claude-bridge/node_modules/claude', '--output-format'],
          name: 'claude',
          pid: 60014,
        },
      ],
      pane_id: 'w9:p1M',
      shell_pid: 59340,
    },
  }
  expect(piProcessOf(answer)).toEqual({
    pid: 59597,
    argv: ['pi', '--model', 'claude-bridge/claude-opus-5-5', '--name', 'x'],
  })
  // Woken through `board resume --pi`: bun leads the group, pi is its child.
  const woken = {
    process_info: {
      foreground_process_group_id: 70000,
      foreground_processes: [
        { argv: ['bun', '/b/src/entrypoints/cli.ts', 'resume', '--pi', 'id'], name: 'bun', pid: 70000 },
        { argv: ['pi', '--session', '/f.jsonl'], name: 'pi', pid: 70001 },
      ],
    },
  }
  expect(piProcessOf(woken)).toEqual({ pid: 70001, argv: ['pi', '--session', '/f.jsonl'] })
  expect(piProcessOf({ process_info: { foreground_processes: [{ name: 'bash', pid: 1 }] } })).toBeNull()
  expect(piProcessOf(null)).toBeNull()
})

const posix = process.platform !== 'win32'

test.if(posix)('for real: a process tree whose children outlive their parent’s SIGTERM is stopped whole', async () => {
  // "pi": a shell that leaves two sleeps behind when it is told to go, one of them in a child shell.
  const root = spawn('sh', ['-c', 'sleep 300 & sh -c "sleep 300 & wait" & trap "exit 0" TERM; wait'], {
    stdio: 'ignore',
  })
  const pid = root.pid as number
  // Its children are started.
  for (let i = 0; i < 50 && descendants(await realProcSys.table(), pid).length < 3; i++) await Bun.sleep(50)
  const before = descendants(await realProcSys.table(), pid)
  expect(before.length).toBeGreaterThanOrEqual(3)
  const r = await stopTree(
    realProcSys,
    pid,
    { now: Date.now, sleep: ms => Bun.sleep(ms) },
    { piExitMs: 3000, restExitMs: 3000 },
  )
  expect(r.left).toEqual([])
  expect(r.tree.sort()).toEqual(before.sort())
  for (const p of before) expect(realProcSys.alive(p)).toBe(false)
})

test.if(process.platform === 'linux')('the account folder a process runs with, from its env', async () => {
  const withDir = spawn('sleep', ['30'], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/home/u/.claude-work' } })
  const { CLAUDE_CONFIG_DIR: _unset, ...rest } = process.env
  const without = spawn('sleep', ['30'], { env: rest })
  try {
    expect(claudeConfigDirOf(withDir.pid as number)).toBe('/home/u/.claude-work')
    expect(claudeConfigDirOf(without.pid as number)).toBe('')
    expect(claudeConfigDirOf(2 ** 22 + 1)).toBeNull()
  } finally {
    withDir.kill('SIGKILL')
    without.kill('SIGKILL')
  }
})

test('elsewhere than Linux the env cannot be read: not known', () => {
  expect(claudeConfigDirOf(process.pid, 'darwin')).toBeNull()
  expect(claudeConfigDirOf(process.pid, 'win32')).toBeNull()
})
