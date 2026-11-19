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

test('the brief for Claude is byte for byte what it was, with and without threads, state and herdr', async () => {
  const old = await before()
  const card = { category: 'acme', doing: 'x', wait: 'CI', ask: 'ok?' }
  const presence = { since: 5, text: 'away' } as never
  for (const e of [{}, env])
    for (const c of [null, card])
      for (const t of [null, threads, { agents: false, gapSec: 60, share: true }])
        for (const sinks of [[], ['bw']])
          expect(brief(cfg, c, 'C:\\X', e, 'Claude', presence, null, sinks, true, t)).toBe(
            old(cfg, c, 'C:\\X', e, 'Claude', presence, null, sinks, true, t),
          )
  expect(BRIEF_VERSION).toBe(6)
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
