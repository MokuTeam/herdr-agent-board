import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRIEF_VERSION, brief, CODEX_BRIEF_VERSION } from '../../src/core/brief.ts'
import type { Config } from '../../src/core/types.ts'
import { oldSource } from '../web/support/old-app.ts'

const cfg = { categories: [{ id: 'acme', title: 'Acme' }] } as unknown as Config
const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3', HERDR_TAB_ID: 'w1:t2', HERDR_WORKSPACE_ID: 'w1' }
const threads = { agents: true, gapSec: 60, share: true }

// The brief as it was before the Codex master's changes (f0d2b0c7): the Claude text must stay byte for byte.
async function before(): Promise<typeof brief> {
  const file = join(import.meta.dir, '..', '..', 'src', 'core', `brief-before-${process.pid}.tmp.ts`)
  writeFileSync(file, oldSource('src/core/brief.ts', 'f0d2b0c7'))
  try {
    return ((await import(file)) as { brief: typeof brief }).brief
  } finally {
    rmSync(file, { force: true })
  }
}

const legacyBrief = (text: string) =>
  text
    .replace(/^- For a long-running external process,.*\n/m, '')
    .replace(
      "  Claude's CronCreate and ScheduleWakeup reminders disappear when the Claude session sleeps or restarts. Board reminders survive both. Use Board reminders for anything due later than a few minutes.",
      "  More reliable than CronCreate or ScheduleWakeup: those live in this Claude process and die when the idle session is put to sleep; the board's entries survive sleep and restarts. Use it for anything due later than a few minutes.",
    )

test('the brief for Claude is byte for byte what it was, with and without threads, state and herdr', async () => {
  const old = await before()
  const card = { category: 'acme', doing: 'x', wait: 'CI', ask: 'ok?' }
  const presence = { since: 5, text: 'away' } as never
  for (const e of [{}, env])
    for (const c of [null, card])
      for (const t of [null, threads, { agents: false, gapSec: 60, share: true }])
        for (const sinks of [[], ['bw']])
          expect(legacyBrief(brief(cfg, c, 'C:\\X', e, 'Claude', presence, null, sinks, true, t))).toBe(
            old(cfg, c, 'C:\\X', e, 'Claude', presence, null, sinks, true, t),
          )
  expect(BRIEF_VERSION).toBe(7)
})

test('the brief for Codex: threads where they are on for agents, no wake from sleep promised', () => {
  const on = brief(cfg, null, 'C:\\X', env, 'Codex', null, null, [], false, threads)
  expect(on).toContain('board thread post <key>')
  expect(on).toContain('agent-board-threads')
  expect(on).toContain('into this session as a prompt; on time')
  expect(on).not.toContain('waking it if it sleeps')
  for (const t of [null, { ...threads, agents: false }])
    expect(brief(cfg, null, 'C:\\X', env, 'Codex', null, null, [], false, t)).not.toContain('board thread')
  // Claude is still told it is woken, and still gets threads only the way it did.
  expect(brief(cfg, null, 'C:\\X', env, 'Claude', null, null, [], false, threads)).toContain('waking it if it sleeps')
  expect(CODEX_BRIEF_VERSION).toBeGreaterThan(BRIEF_VERSION)
})

test('the brief for Codex says to run board bare, so the allow rule lets it out of the sandbox (#916); Claude is not told', () => {
  const line = 'Run each board command as a shell call of its own that starts with board'
  for (const e of [{}, env]) {
    expect(brief(cfg, null, 'C:\\X', e, 'Codex')).toContain(line)
    expect(brief(cfg, null, 'C:\\X', e, 'Claude')).not.toContain(line)
    expect(brief(cfg, null, 'C:\\X', e, 'Antigravity')).not.toContain(line)
  }
  // Above what Codex cards were stamped with before it (#918's merge), so they hear the new text once.
  const was = Number(/CODEX_BRIEF_VERSION = (\d+)/.exec(oldSource('src/core/brief.ts', '3bd59765'))?.[1])
  expect(CODEX_BRIEF_VERSION).toBeGreaterThan(was)
})

test("Codex with the board's MCP tools: its fallback runs board as a call of its own, never inside a script (#916); Claude's as before", () => {
  const bare = 'run it as a shell call of its own that starts with board, nothing before or after it'
  for (const session of [undefined, '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b']) {
    const opts = { mcp: true, ...(session && { session }) }
    const codex = brief(cfg, null, 'C:\\X', env, 'Codex', null, null, [], false, null, false, null, opts)
    expect(codex).toContain(bare)
    expect(codex).not.toContain('inside a shell probe/script')
    if (session) expect(codex).toContain(`\`board --session ${session} <command>\``)
    for (const agent of ['Claude', 'Antigravity'] as const) {
      const other = brief(cfg, null, 'C:\\X', env, agent, null, null, [], false, null, false, null, opts)
      expect(other).toContain('- Fallback: if the MCP server is unavailable or inside a shell probe/script, use ')
      expect(other).not.toContain(bare)
    }
  }
})
