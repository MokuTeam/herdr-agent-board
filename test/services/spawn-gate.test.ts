import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HerdrPane } from '../../src/adapters/herdr.ts'
import { readSpawns } from '../../src/adapters/spawn-ledger.ts'
import { parseArgs, type SpawnOptions } from '../../src/core/launch/spawn-args.ts'
import type { Config } from '../../src/core/types.ts'
import { callerEnv } from '../../src/entrypoints/mcp-http.ts'
import { callerParty, type GateDeps, gated, gateSpawn } from '../../src/services/launch/spawn-gate.ts'

// spawn-agent's gate (#815): the limits checked against the ledger, the start written there.
const NOW = 1_800_000_000_000
const SID = 'atlas-sid'
const SESSION_ENV = { CLAUDE_CODE_SESSION_ID: SID, HERDR_PANE_ID: 'w1:p1' }
const opts = (...more: string[]): SpawnOptions => {
  const o = parseArgs(['--name', 'Acme', '--cwd', tmpdir(), ...more])
  if ('help' in o && o.help) throw new Error('not a start')
  return o as SpawnOptions
}

function box(cfg: Partial<Config> = {}, env: Record<string, string> = SESSION_ENV) {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-gate-'))
  const file = join(dir, 'spawns.json')
  const herdrCalls: string[] = []
  const asks: string[] = []
  let panes: HerdrPane[] = []
  const deps = (now = NOW): GateDeps => ({
    env,
    cfg: cfg as Config,
    now,
    file,
    panes: async () => {
      herdrCalls.push('snapshot')
      return panes
    },
    items: async () => null,
    ask: async text => {
      asks.push(text)
    },
  })
  return {
    file,
    deps,
    herdrCalls,
    asks,
    setPanes(p: HerdrPane[]) {
      panes = p
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('who is gated: a session by its id, pi by its pane; never the owner nor a plain terminal', () => {
  const noCard = () => null
  expect(callerParty({}, noCard)).toBeNull()
  expect(callerParty({ HERDR_PANE_ID: 'w1:p4' }, noCard)).toBeNull()
  expect(callerParty({ HERDR_PANE_ID: 'w1:p4', PI_CODING_AGENT: 'true' }, noCard)).toEqual({ pane: 'w1:p4' })
  expect(callerParty({ CLAUDE_CODE_SESSION_ID: SID }, noCard)).toEqual({ session: SID })
  expect(callerParty({ ANTIGRAVITY_CONVERSATION_ID: 'agy-1', HERDR_PANE_ID: 'w1:p5' }, noCard)).toEqual({
    session: 'agy-1',
    pane: 'w1:p5',
  })
  // A root Codex that carries the Claude id its hook recorded is the Codex session; a Claude child in it is Claude.
  const env = { CODEX_THREAD_ID: 'cx-1', CLAUDE_CODE_SESSION_ID: 'cl-1' }
  expect(callerParty(env, (() => ({ key: 'cx-1', codexParentClaude: 'cl-1' })) as never)).toEqual({ session: 'cx-1' })
  expect(callerParty(env, noCard)).toEqual({ session: 'cl-1' })
})

test('what is gated: a new session; a resume, a start in a pane and a Workdesk worker are not', () => {
  expect(gated(opts())).toBe(true)
  expect(gated(opts('--resume', '0f8fad5b-d9cb-469f-a165-70867728950e'))).toBe(false)
  expect(gated(opts('--pane', 'w1:p1'))).toBe(false)
})

test('the owner: nothing read, nothing written, herdr not asked', async () => {
  const b = box({ spawnLimits: { agents: false } }, {})
  try {
    expect(await gateSpawn(opts(), b.deps())).toBeNull()
    expect(existsSync(b.file)).toBe(false)
    expect(b.herdrCalls).toEqual([])
  } finally {
    b.done()
  }
})

test("a session's start under the limits: written, herdr not asked, settled with the session it became", async () => {
  const b = box()
  try {
    const gate = await gateSpawn(opts(), b.deps())
    expect(gate).not.toBeNull()
    expect(b.herdrCalls).toEqual([])
    const [e] = readSpawns(b.file)
    expect(e?.by).toEqual({ session: SID, pane: 'w1:p1' })
    expect(e?.name).toBe('Acme')
    expect(e?.child).toBeUndefined()
    gate?.settle('pane=wA:p9 name=Acme agent=acme', { pane: 'wA:p9', session: 'child-sid' })
    expect(readSpawns(b.file)[0]?.child).toEqual({ pane: 'wA:p9', session: 'child-sid' })
  } finally {
    b.done()
  }
})

test('a start that failed is taken out of the ledger', async () => {
  const b = box()
  try {
    const gate = await gateSpawn(opts(), b.deps())
    gate?.settle(null)
    expect(readSpawns(b.file)).toEqual([])
  } finally {
    b.done()
  }
})

test('per hour: the start past the limit is refused with one line and a question for the owner', async () => {
  const b = box({ spawnLimits: { perHour: 2 } })
  try {
    for (let i = 0; i < 2; i++) (await gateSpawn(opts(), b.deps(NOW + i)))?.settle(`pane=wA:p${i} name=Acme agent=a`)
    await expect(gateSpawn(opts(), b.deps(NOW + 5))).rejects.toThrow(
      'this session started 2 sessions in the last hour, the limit is 2',
    )
    expect(b.asks).toHaveLength(1)
    expect(b.asks[0]).toContain('Acme')
    // A rule that does not depend on which sessions run: herdr is not asked.
    expect(b.herdrCalls).toEqual([])
    expect(readSpawns(b.file)).toHaveLength(2)
    // An hour on, it may again.
    expect(await gateSpawn(opts(), b.deps(NOW + 3600_001))).not.toBeNull()
  } finally {
    b.done()
  }
})

test('children: sessions that ended do not count, by what herdr says', async () => {
  const b = box({ spawnLimits: { children: 2 } })
  try {
    for (let i = 0; i < 2; i++) (await gateSpawn(opts(), b.deps(NOW + i)))?.settle(`pane=wA:p${i} name=Acme agent=a`)
    const later = NOW + 30 * 60_000
    // Both still run: refused, after one look at herdr.
    b.setPanes([
      { pane_id: 'w1:p1', agent: 'claude' },
      { pane_id: 'wA:p0', agent: 'claude' },
      { pane_id: 'wA:p1', agent: 'claude' },
    ])
    await expect(gateSpawn(opts(), b.deps(later))).rejects.toThrow('2 sessions this session started still run')
    expect(b.herdrCalls).toEqual(['snapshot'])
    // One ended (its pane gone): room for one.
    b.setPanes([
      { pane_id: 'w1:p1', agent: 'claude' },
      { pane_id: 'wA:p1', agent: 'claude' },
    ])
    expect(await gateSpawn(opts(), b.deps(later + 1))).not.toBeNull()
  } finally {
    b.done()
  }
})

test("depth: a session's own child's child is refused at depth 1; herdr unreachable lets it through", async () => {
  const b = box({ spawnLimits: { depth: 1 } })
  try {
    ;(await gateSpawn(opts(), b.deps()))?.settle('pane=wA:p9 name=Acme agent=a', { pane: 'wA:p9', session: 'ben-sid' })
    const ben: GateDeps = {
      ...b.deps(NOW + 60_000),
      env: { CLAUDE_CODE_SESSION_ID: 'ben-sid', HERDR_PANE_ID: 'wA:p9' },
    }
    b.setPanes([
      { pane_id: 'w1:p1', agent: 'claude' },
      { pane_id: 'wA:p9', agent: 'claude' },
    ])
    await expect(gateSpawn(opts(), ben)).rejects.toThrow('2 levels of agent starts deep, the limit is 1')
    // herdr does not answer: never in the owner's way.
    await expect(
      gateSpawn(opts(), { ...ben, panes: async () => Promise.reject(new Error('no herdr')) }),
    ).resolves.not.toBeNull()
  } finally {
    b.done()
  }
})

test('a plain terminal is the owner: let through with nothing written and herdr not asked; pi in a pane is a session', async () => {
  const shell = box({ spawnLimits: { agents: false } }, { HERDR_PANE_ID: 'w1:p7' })
  try {
    expect(await gateSpawn(opts(), shell.deps())).toBeNull()
    expect(existsSync(shell.file)).toBe(false)
    expect(shell.herdrCalls).toEqual([])
  } finally {
    shell.done()
  }
  const pi = box({ spawnLimits: { agents: false } }, { HERDR_PANE_ID: 'w1:p7', PI_CODING_AGENT: 'true' })
  try {
    await expect(gateSpawn(opts(), pi.deps())).rejects.toThrow('may not start sessions')
    expect(pi.herdrCalls).toEqual([])
  } finally {
    pi.done()
  }
})

test('a ledger that cannot be written lets the start through, saying so', async () => {
  const b = box()
  const lines: string[] = []
  try {
    writeFileSync(join(b.file, '..', 'not-a-folder'), '')
    const gate = await gateSpawn(opts(), {
      ...b.deps(),
      file: join(b.file, '..', 'not-a-folder', 'spawns.json'),
      log: l => lines.push(l),
    })
    expect(gate).toBeNull()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('limits not checked: ')
  } finally {
    b.done()
  }
})

test('the ledger on disk is JSON with the entries only', async () => {
  const b = box()
  try {
    await gateSpawn(opts(), b.deps())
    const raw = JSON.parse(readFileSync(b.file, 'utf8'))
    expect(Object.keys(raw)).toEqual(['entries'])
  } finally {
    b.done()
  }
})

test("the board's MCP: a caller named by its pane alone is a session, refused by agents off; no caller is the owner", async () => {
  const noCard = () => null
  // The board runs in a pane of its own, maybe started from a session: none of that is the caller.
  const board = { PATH: '/bin', HERDR_PANE_ID: 'w0:p0', CLAUDE_CODE_SESSION_ID: 'board-own', CODEX_THREAD_ID: 'cx-own' }
  expect(callerParty(callerEnv(board, null), noCard)).toBeNull()
  // Claude Code and Codex send X-Board-Pane only: the child gets the pane and the MCP's mark.
  const paneOnly = callerEnv(board, { pane: 'w1:p1', cwd: '/work/anna' })
  expect(callerParty(paneOnly, noCard)).toEqual({ pane: 'w1:p1' })
  expect(callerParty(callerEnv(board, { session: SID, pane: 'w1:p1' }), noCard)).toEqual({
    session: SID,
    pane: 'w1:p1',
  })
  const b = box({ spawnLimits: { agents: false } }, paneOnly)
  try {
    await expect(gateSpawn(opts(), b.deps())).rejects.toThrow('may not start sessions')
    expect(b.asks).toHaveLength(1)
    expect(b.herdrCalls).toEqual([])
  } finally {
    b.done()
  }
})
