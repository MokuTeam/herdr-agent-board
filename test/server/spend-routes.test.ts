import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { isSessionDetail } from '../../web/src/api/client.ts'
import { isSpendReport } from '../../web/src/models/spend.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

describe('spend HTTP routes', () => {
  test('GET /api/spend and GET /api/session/<key> return spend while /api/board stays unchanged and agy has no spend', async () => {
    const box = await sandbox()
    const home = box.env.HOME as string
    const claudeRoot = join(home, '.claude')
    const codexRoot = join(home, '.codex')
    const piRoot = join(home, '.pi', 'agent', 'sessions')
    const projDir = join(home, 'work-atlas')
    mkdirSync(projDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    const cId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const xId = 'bbbbbbbb-2222-4222-8222-222222222222'
    const aId = 'cccccccc-3333-4333-8333-333333333333'

    const cProj = join(claudeRoot, 'projects', projectFolderName(projDir))
    mkdirSync(cProj, { recursive: true })
    writeFileSync(
      join(cProj, `${cId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: `${today}T10:00:00Z`,
        message: {
          id: 'cm1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 500 },
        },
      })}\n`,
    )

    const [y, m, d] = today.split('-') as [string, string, string]
    const xDir = join(codexRoot, 'sessions', y, m, d)
    mkdirSync(xDir, { recursive: true })
    writeFileSync(
      join(xDir, `rollout-${today}T10-00-00-${xId}.jsonl`),
      `${[
        JSON.stringify({ timestamp: `${today}T10:00:00Z`, type: 'session_meta', payload: { id: xId, cwd: projDir } }),
        JSON.stringify({
          timestamp: `${today}T10:01:00Z`,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 200, output_tokens: 50 } },
          },
        }),
      ].join('\n')}\n`,
    )

    mkdirSync(piRoot, { recursive: true })
    const piFile = join(piRoot, `${today}T10-00-00-000Z_dddddddd-4444-4444-8444-444444444444.jsonl`)
    writeFileSync(
      piFile,
      `${[
        JSON.stringify({ type: 'session', version: 3, id: 'dddd', timestamp: `${today}T10:00:00Z`, cwd: projDir }),
        JSON.stringify({
          type: 'message',
          id: 'pm1',
          parentId: null,
          timestamp: `${today}T10:02:00Z`,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input: 10, output: 15, cacheRead: 100, cacheWrite: 5 },
          },
        }),
      ].join('\n')}\n`,
    )

    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: 'p1', agent: 'claude', agent_session: { value: cId }, agent_status: 'idle', cwd: projDir },
              { pane_id: 'p2', agent: 'codex', agent_session: { value: xId }, agent_status: 'idle', cwd: projDir },
              { pane_id: 'p3', agent: 'pi', agent_session: { value: piFile }, agent_status: 'idle', cwd: projDir },
              { pane_id: 'p4', agent: 'agy', agent_session: { value: aId }, agent_status: 'idle', cwd: projDir },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })

    const { url } = await serveBoard(box, {
      language: 'en',
      categories: [
        { id: 'atlas', title: 'Atlas', color: 'cyan', paths: [projDir] },
        { id: 'other', title: 'Other', color: 'gray', paths: [] },
      ],
      time: { on: true, zone: 'UTC' },
    })

    // Board payload stays unchanged (no spend field on payload or items).
    const board = (await (await fetch(`${url}/api/board`)).json()) as { items: Record<string, unknown>[] }
    expect('spend' in board).toBe(false)
    for (const it of board.items) expect('spend' in it).toBe(false)

    // Detail includes spend for Claude, Codex, and pi; omits for agy.
    for (const [key, expectedTotal] of [
      [cId, 650],
      [xId, 450],
      [piFile, 130],
    ] as const) {
      const detail = await (await fetch(`${url}/api/session/${encodeURIComponent(key)}`)).json()
      expect(isSessionDetail(detail)).toBe(true)
      expect(detail.spend?.total.total).toBe(expectedTotal)
    }
    const agyDetail = await (await fetch(`${url}/api/session/${encodeURIComponent(aId)}`)).json()
    expect(isSessionDetail(agyDetail)).toBe(true)
    expect('spend' in agyDetail).toBe(false)

    // GET /api/spend aggregates across all 3 transcripts for today in UTC.
    const spendRes = await fetch(`${url}/api/spend?day=${today}`)
    expect(spendRes.status).toBe(200)
    const report = await spendRes.json()
    expect(isSpendReport(report)).toBe(true)
    if (!isSpendReport(report)) throw new Error('expected SpendReport')
    expect(report.total.total).toBe(650 + 450 + 130)
    expect(report.lanes.map(l => [l.lane, l.sessions])).toEqual([['atlas', 3]])

    // Invalid query parameters return 400.
    expect((await fetch(`${url}/api/spend?day=not-a-date`)).status).toBe(400)
    expect((await fetch(`${url}/api/spend?day=${today}&from=${today}`)).status).toBe(400)
  }, 20_000)
})
