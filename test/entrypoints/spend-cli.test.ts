import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexHome } from '../../src/adapters/codex-home.ts'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { clearSpendCache } from '../../src/adapters/spend-reader.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Config } from '../../src/core/types.ts'
import { SPEND_USAGE, spendCmd } from '../../src/entrypoints/spend-cli.ts'
import { isolatedHome } from '../support/env.ts'

afterEach(() => {
  clearSpendCache()
})

describe('board spend CLI', () => {
  test('prints summary, lane filter, --day, --json, --help, and usage errors cleanly', async () => {
    const dir = isolatedHome()
    const home = join(dir, 'home')
    const claudeRoot = join(home, '.claude')
    const workDir = join(home, 'atlas')
    const personalDir = join(home, 'personal')
    mkdirSync(workDir, { recursive: true })
    mkdirSync(personalDir, { recursive: true })

    const p1 = join(claudeRoot, 'projects', projectFolderName(workDir))
    const p2 = join(claudeRoot, 'projects', projectFolderName(personalDir))
    mkdirSync(p1, { recursive: true })
    mkdirSync(p2, { recursive: true })

    writeFileSync(
      join(p1, 's-atlas.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        cwd: workDir,
        timestamp: '2026-11-23T10:00:00Z',
        message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200 } },
      })}\n`,
    )
    writeFileSync(
      join(p2, 's-pers.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        cwd: personalDir,
        timestamp: '2026-11-22T10:00:00Z',
        message: { id: 'm2', model: 'claude-sonnet-4-6', usage: { input_tokens: 300, output_tokens: 50 } },
      })}\n`,
    )

    const cfg: Config = {
      language: 'en',
      categories: [
        { id: 'atlas', title: 'Atlas', color: 'cyan', paths: [workDir] },
        { id: 'personal', title: 'Personal', color: 'green', paths: [personalDir] },
        { id: 'other', title: 'Other', color: 'gray', paths: [] },
      ],
      placement: 'workspace',
      workspace: 'Board',
      refreshSec: 2,
      wakeUrl: null,
      scheduleWaitMin: 240,
    }
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeRoot, hidden: false, color: 'cyan' }],
      claudeRoot,
    )
    const deps = {
      profiles: () => profiles,
      homes: createProfileHomes(),
      codex: createCodexHome(join(home, 'no-codex')),
    }
    const now = Date.parse('2026-11-23T15:00:00Z')
    const run = async (argv: string[]) => {
      const out: string[] = []
      const err: string[] = []
      const code = await spendCmd(argv, {
        cfg,
        deps,
        now,
        zone: 'UTC',
        codexRoots: [],
        piRoots: [],
        out: l => out.push(l),
        err: l => err.push(l),
      })
      return { code, out: out.join('\n'), err: err.join('\n') }
    }

    const help = await run(['--help'])
    expect(help).toEqual({ code: 0, out: SPEND_USAGE, err: '' })

    const today = await run([])
    expect(today.code).toBe(0)
    expect(today.out).toContain('spend · 2026-11-23 · total 1.2k')
    expect(today.out).toContain('atlas · 1.2k')
    expect(today.out).not.toContain('personal')

    const yesterdayJson = await run(['--day', 'yesterday', '--json'])
    expect(yesterdayJson.code).toBe(0)
    const parsed = JSON.parse(yesterdayJson.out) as {
      from: string
      total: { total: number }
      lanes: { lane: string }[]
    }
    expect(parsed.from).toBe('2026-11-22')
    expect(parsed.total.total).toBe(350)
    expect(parsed.lanes.map(l => l.lane)).toEqual(['personal'])

    const filtered = await run(['--from', '2026-11-22', '--to', '2026-11-23', '--lane', 'atlas'])
    expect(filtered.code).toBe(0)
    expect(filtered.out).toContain('lane atlas · total 1.2k')

    const bad = await run(['--day', '2026-11-23', '--from', '2026-11-22', '--json'])
    expect(bad.code).toBe(1)
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false, error: 'usage' })
  })
})
