import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgyHome } from '../../src/adapters/agy-home.ts'

const ID = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
const CHILD = '909adb87-3850-4c02-acf4-dc87166db197'
const OTHER = 'a1b2c3d4-e5f6-4789-abcd-0123456789ef'

const dirs: string[] = []
function makeRoot(suffix = 'agy-home'): string {
  const dir = mkdtempSync(join(tmpdir(), `${suffix}-`))
  dirs.push(dir)
  return dir
}

function writeTranscript(root: string, id: string, lines: Record<string, unknown>[]): string {
  const file = join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  mkdirSync(join(root, 'brain', id, '.system_generated', 'logs'), { recursive: true })
  writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return file
}

function writeSummariesDb(
  root: string,
  rows: {
    id: string
    title: string
    workspace: string
    status?: string
    parent?: string
    agentName?: string
    modified?: string
    killed?: number
  }[],
): void {
  const db = new Database(join(root, 'conversation_summaries.db'))
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT "",
        preview text NOT NULL DEFAULT "",
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT "",
        agent_name text NOT NULL DEFAULT "",
        parent_conversation_id text NOT NULL DEFAULT "",
        killed numeric NOT NULL DEFAULT false
      )
    `)
    const ins = db.query(
      `INSERT INTO conversation_summaries
       (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, killed)
       VALUES (?, ?, ?, 5, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      ins.run(
        r.id,
        r.title,
        r.title,
        r.modified ?? '2026-11-23 12:47:20.000+00:00',
        JSON.stringify([`file://${r.workspace}`]),
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.agentName ?? '',
        r.parent ?? '',
        r.killed ?? 0,
      )
    }
  } finally {
    db.close(false)
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('AgyHome adapter (adapters/agy-home.ts)', () => {
  test('reads transcripts, DB titles/cwds, subagent helpers, helper detail, and history', async () => {
    const root = makeRoot('agy дом 100%')
    const cwd = join(root, 'work')
    mkdirSync(cwd, { recursive: true })
    writeTranscript(root, ID, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T12:47:12Z',
        content: '<USER_REQUEST>\nBuild agy adapter\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:47:15Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 4000,
        content: 'Adapter is ready. Ship it?',
      },
    ])
    writeTranscript(root, CHILD, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T12:47:13Z',
        content: '<USER_REQUEST>\nInspect files\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:47:14Z',
        model: 'gemini-3.8-flash-high',
        tool_calls: [{ name: 'read_file', args: { Path: '"/repo/README.md"' } }],
      },
    ])
    writeTranscript(root, OTHER, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-22T10:00:00Z',
        content: '<USER_REQUEST>\nPrevious deploy checklist\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T10:01:00Z',
        content: 'Deploy checklist verified.',
      },
    ])
    writeSummariesDb(root, [
      { id: ID, title: 'Build Agy Adapter', workspace: cwd, status: 'CASCADE_RUN_STATUS_IDLE' },
      {
        id: CHILD,
        title: 'Codebase Researcher',
        workspace: cwd,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        parent: ID,
        agentName: 'research',
      },
      { id: OTHER, title: 'Deploy Run', workspace: cwd, modified: '2026-11-22 10:01:00.000+00:00' },
    ])

    const home = createAgyHome(root)
    expect(home.transcriptPath(ID)).toContain(ID)
    expect(home.transcriptPath('not-a-uuid')).toBeNull()
    expect(home.sessionTitle(ID)).toBe('Build Agy Adapter')
    expect(home.sessionCwd(ID)).toBe(cwd)
    expect(home.transcriptInfo(ID)).toMatchObject({
      title: 'Build Agy Adapter',
      prompt: 'Build agy adapter',
      lastText: 'Adapter is ready. Ship it?',
      question: 'Adapter is ready. Ship it?',
      context: 5000,
      model: 'gemini-4-neon-high',
      effort: 'high',
    })
    expect(home.sessionThread(ID).conversation).toHaveLength(2)

    const { helpers } = home.sessionHelpers(ID)
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).toMatchObject({
      id: CHILD,
      type: 'research',
      description: 'Codebase Researcher',
      status: 'running',
      now: { name: 'read_file', detail: 'README.md' },
    })

    const detail = home.helperDetail(ID, CHILD)
    expect(detail?.helper.id).toBe(CHILD)
    expect(detail?.conversation.map(t => t.role)).toEqual(['user', 'tool'])

    const history = await home.searchHistory(cwd, 'checklist', ID)
    expect(history.results).toHaveLength(2)
    expect(history.results[0]).toMatchObject({ session: OTHER, title: 'Deploy Run', source: 'agy' })
  })

  test('degrades cleanly when transcript or summaries DB is missing or unreadable', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'conversation_summaries.db'), 'not sqlite')
    const home = createAgyHome(root)
    expect(home.transcriptInfo(ID)).toBeNull()
    expect(home.sessionThread(ID)).toEqual({ conversation: [], queued: [] })
    expect(home.sessionHelpers(ID)).toEqual({ helpers: [], workflows: [] })
    expect(home.helperDetail(ID, CHILD)).toBeNull()
  })
})
