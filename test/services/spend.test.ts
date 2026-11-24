import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCard } from '../../src/adapters/cards.ts'
import { createCodexHome } from '../../src/adapters/codex-home.ts'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { clearSpendCache } from '../../src/adapters/spend-reader.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { collectSpend, sessionSpend } from '../../src/services/spend.ts'
import { isolatedHome } from '../support/env.ts'

afterEach(() => {
  clearSpendCache()
})

function cfgOf(homeDir: string, extra: Partial<Config> = {}): Config {
  return {
    language: 'en',
    categories: [
      { id: 'atlas', title: 'Atlas', color: 'cyan', paths: [join(homeDir, 'atlas')] },
      { id: 'personal', title: 'Personal', color: 'green', paths: [] },
      { id: 'other', title: 'Other', color: 'gray', paths: [] },
    ],
    placement: 'workspace',
    workspace: 'Board',
    refreshSec: 2,
    wakeUrl: null,
    scheduleWaitMin: 240,
    ...extra,
  }
}

describe('spend service', () => {
  test('aggregates Claude, Codex, and pi transcripts into lanes and days, respects forkAt and mtime cutoff', async () => {
    const dir = isolatedHome()
    const home = join(dir, 'home')
    const claudeRoot = join(home, '.claude')
    const codexRoot = join(home, '.codex')
    const piRoot = join(home, '.pi', 'agent', 'sessions')
    const atlasDir = join(home, 'atlas')
    mkdirSync(atlasDir, { recursive: true })

    // 1. Claude session in atlas (resolved via cwd path rule)
    const cProj = join(claudeRoot, 'projects', projectFolderName(atlasDir))
    mkdirSync(cProj, { recursive: true })
    const cId = '11111111-1111-4111-8111-111111111111'
    writeFileSync(
      join(cProj, `${cId}.jsonl`),
      `${[
        JSON.stringify({ type: 'user', cwd: atlasDir, timestamp: '2026-11-23T09:00:00Z', message: { content: 'hi' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'anna-api' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T09:01:00Z',
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500 },
          },
        }),
      ].join('\n')}\n`,
    )

    // 2. Forked Claude session with forkAt: ignores parent line before forkAt
    const fId = '22222222-2222-4222-8222-222222222222'
    const forkAt = Date.parse('2026-11-23T11:00:00Z')
    writeCard(fId, { category: 'personal', name: 'ben-fork', forkOf: cId, forkAt })
    writeFileSync(
      join(cProj, `${fId}.jsonl`),
      `${[
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T09:01:00Z',
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T11:05:00Z',
          message: { id: 'm2', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 20 } },
        }),
      ].join('\n')}\n`,
    )

    // 3. Old Claude transcript with mtime far before range: skipped
    const oldId = '33333333-3333-4333-8333-333333333333'
    const oldFile = join(cProj, `${oldId}.jsonl`)
    writeFileSync(
      oldFile,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T10:00:00Z',
        message: { id: 'old', model: 'claude-sonnet-4-6', usage: { input_tokens: 9999, output_tokens: 1 } },
      })}\n`,
    )
    const oldTime = new Date('2026-10-01T10:00:00Z')
    utimesSync(oldFile, oldTime, oldTime)

    // 4. Codex rollout
    const codexId = '44444444-4444-4444-8444-444444444444'
    const codexDir = join(codexRoot, 'sessions', '2026', '11', '23')
    mkdirSync(codexDir, { recursive: true })
    writeCard(codexId, { category: 'atlas', name: 'cleo-codex' })
    writeFileSync(
      join(codexDir, `rollout-2026-11-23T12-00-00-${codexId}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: '2026-11-23T12:00:00Z',
          type: 'session_meta',
          payload: { id: codexId, cwd: atlasDir },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T12:01:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 30 } },
          },
        }),
      ].join('\n')}\n`,
    )

    // 5. pi session
    const piSub = join(piRoot, '--atlas--')
    mkdirSync(piSub, { recursive: true })
    const piFile = join(piSub, '2026-11-23T13-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl')
    writeFileSync(
      piFile,
      `${[
        JSON.stringify({ type: 'session', version: 3, id: '5555', timestamp: '2026-11-23T13:00:00Z', cwd: atlasDir }),
        JSON.stringify({ type: 'session_info', id: 'sinfo', parentId: null, name: 'atlas-pi' }),
        JSON.stringify({
          type: 'message',
          id: 'pm1',
          parentId: 'sinfo',
          timestamp: '2026-11-23T13:01:00Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input: 20, output: 10, cacheRead: 100, cacheWrite: 0 },
          },
        }),
      ].join('\n')}\n`,
    )

    const cfg = cfgOf(home)
    const homes = createProfileHomes()
    const codex = createCodexHome(codexRoot)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeRoot, hidden: false, color: 'cyan' }],
      claudeRoot,
    )
    const deps = {
      profiles: () => profiles,
      homes,
      codex,
    }

    const report = await collectSpend({
      cfg,
      deps,
      from: '2026-11-23',
      to: '2026-11-23',
      zone: 'UTC',
      codexRoots: [codexRoot],
      piRoots: [piRoot],
    })

    expect(report.total.total).toBe(640 + 70 + 430 + 130)
    expect(report.lanes.map(l => [l.lane, l.counts.total, l.sessions])).toEqual([
      ['atlas', 640 + 430 + 130, 3],
      ['personal', 70, 1],
    ])
    expect(report.sessions.find(s => s.key === cId)?.name).toBe('anna-api')
    expect(report.sessions.find(s => s.key === fId)?.counts.total).toBe(70)
    expect(report.sessions.find(s => s.key === codexId)?.name).toBe('cleo-codex')
    expect(report.sessions.find(s => s.key === piFile)?.name).toBe('atlas-pi')
  })

  test('sessionSpend returns null for agy items, transcript-less panes, and setups without Codex/pi dirs', async () => {
    const dir = isolatedHome()
    const home = join(dir, 'home')
    const cfg = cfgOf(home)
    const deps = { cfg, codex: createCodexHome(join(home, 'no-codex')) }
    const base: Item = {
      key: 'pane-1',
      session: null,
      pane: 'p1',
      workspace: 'ws',
      cwd: home,
      status: 'idle',
      name: 'anna',
      autoName: 'anna',
      category: 'atlas',
      categorySet: true,
      column: 'idle',
      attention: '',
    }
    expect(await sessionSpend(deps, base)).toBeNull()
    expect(
      await sessionSpend(deps, { ...base, agent: 'agy', session: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).toBeNull()
  })
})
