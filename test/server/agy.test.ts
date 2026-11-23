import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Item = Record<string, unknown>
type Detail = { conversation: Item[]; queued: unknown[]; helpers: Item[] }
const ID = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
const WORKING = '18fb0773-7c19-4e3d-8e9b-ceadaef29212'
const CHILD = '909adb87-3850-4c02-acf4-dc87166db197'
const MISSING = '18fb0773-7c19-4e3d-8e9b-ceadaef29219'
const CLAUDE = '030bc85e-c173-4999-b250-c85a4d5595bd'

describe('Antigravity CLI sessions on the board, beside Claude and pi', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Awaited<ReturnType<typeof sandbox>>
  let projectDir = ''
  const board = async (): Promise<Item[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items
  const detail = async (key: string): Promise<Detail> =>
    (await (await fetch(`${url}/api/session/${encodeURIComponent(key)}`)).json()) as Detail
  const post = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Board': '1', Origin: url },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    box = await sandbox()
    const agyRoot = join(box.dir, 'Agy дом 100%')
    const agyConfig = join(box.dir, 'Agy config')
    projectDir = join(box.dir, 'project')
    mkdirSync(join(projectDir, '.agents', 'skills', 'deploy-check'), { recursive: true })
    writeFileSync(
      join(projectDir, '.agents', 'skills', 'deploy-check', 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Verify deployment readiness\n---\nCheck things.\n',
    )
    mkdirSync(join(agyConfig, 'skills', 'herdr-agents'), { recursive: true })
    writeFileSync(
      join(agyConfig, 'skills', 'herdr-agents', 'SKILL.md'),
      '---\nname: herdr-agents\ndescription: Coordinate agents in herdr\n---\nDocs.\n',
    )

    const writeAgy = (id: string, lines: Record<string, unknown>[]) => {
      const dir = join(agyRoot, 'brain', id, '.system_generated', 'logs')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'transcript.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    }
    writeAgy(ID, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T12:47:12Z',
        content:
          '<USER_REQUEST>\nimplement agy support\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:47:15Z',
        model: 'gemini-4-neon-high',
        input_tokens: 10000,
        cache_read_tokens: 20000,
        tool_calls: [{ name: 'read_file', args: { Path: '"/repo/src/core/agy.ts"' } }],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-23T12:47:16Z', content: 'ok' },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:47:20Z',
        model: 'gemini-4-neon-high',
        input_tokens: 12000,
        cache_read_tokens: 30000,
        content: 'Done! Shall I push?',
      },
    ])
    writeAgy(CHILD, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T12:47:13Z',
        content: '<USER_REQUEST>\nAudit files\n</USER_REQUEST>',
      },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T12:47:14Z', content: 'Audit complete.' },
    ])
    writeAgy(WORKING, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T12:47:12Z',
        content: '<USER_REQUEST>\nRun long build\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:47:13Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"bun run build"' } }],
      },
    ])

    const db = new Database(join(agyRoot, 'conversation_summaries.db'))
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
    db.query('INSERT INTO conversation_summaries VALUES (?, ?, ?, 4, ?, ?, ?, ?, ?, 0)').run(
      ID,
      'Agy Full Support',
      'Agy Full Support',
      '2026-11-23 12:47:20+00:00',
      JSON.stringify([`file://${projectDir}`]),
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
    )
    db.query('INSERT INTO conversation_summaries VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, 0)').run(
      CHILD,
      'Audit Subagent',
      'Audit Subagent',
      '2026-11-23 12:47:14+00:00',
      JSON.stringify([`file://${projectDir}`]),
      'CASCADE_RUN_STATUS_IDLE',
      'research',
      ID,
    )
    db.close(false)

    // Same-id Claude transcript must never leak into MISSING agy session.
    const projects = join(box.dir, 'home', '.claude', 'projects', 'fixture')
    mkdirSync(projects, { recursive: true })
    for (const id of [CLAUDE, MISSING])
      writeFileSync(
        join(projects, `${id}.jsonl`),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude answer' }] } }),
      )

    const pane = (pane_id: string, agent: string, session?: string, status = 'idle') => ({
      pane_id,
      tab_id: `t-${pane_id}`,
      workspace_id: 'w1',
      agent,
      agent_status: status,
      cwd: projectDir,
      label: `Session ${pane_id}`,
      ...(session && { agent_session: { value: session } }),
    })
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              pane('a1', 'agy', ID),
              pane('a2', 'agy', WORKING, 'working'),
              pane('a3', 'agy', MISSING),
              pane('a4', 'agy'),
              pane('c1', 'claude', CLAUDE),
            ],
            tabs: [],
            workspaces: [{ workspace_id: 'w1', label: 'Work' }],
          },
        },
      },
      'agent get a1': { result: { agent: { agent: 'agy', agent_status: 'idle', agent_session: { value: ID } } } },
      'agent get a2': {
        until: ['agent send-keys'],
        // biome-ignore lint/suspicious/noThenProperty: fake-herdr reply transition
        then: { result: { agent: { agent: 'agy', agent_status: 'idle', agent_session: { value: WORKING } } } },
        result: { agent: { agent: 'agy', agent_status: 'working', agent_session: { value: WORKING } } },
      },
      'agent read a2': { text: 'Running bun run build...\n' },
      'agent send-keys a2': { result: {} },
      'pane get a1': { result: { pane: pane('a1', 'agy', ID) } },
      'pane get a2': { result: { pane: pane('a2', 'agy', WORKING, 'working') } },
      'agent prompt a1': { result: {} },
      'agent rename a1': { result: {} },
      'pane read a1': { text: 'Conversation renamed\n' },
      'agent list': { result: { agents: [] } },
      'workspace list': { result: { workspaces: [{ workspace_id: 'w1', label: 'Work' }] } },
      'tab create': { result: { tab: { tab_id: 't-new' }, root_pane: { pane_id: 'a9', terminal_id: 'term-9' } } },
      'pane run': { result: {} },
      'pane get a9': {
        seq: [
          { result: { pane: { ...pane('a9', 'agy', ID), agent: null } } },
          { result: { pane: pane('a9', 'agy', ID) } },
        ],
      },
      'agent rename a9': { result: {} },
    })

    ;({ url } = await serveBoard(
      box,
      { language: 'en', launch: { agy: 'agy' } },
      { ANTIGRAVITY_APP_DATA_DIR: agyRoot, ANTIGRAVITY_CONFIG_DIR: agyConfig, BOARD_TEST_PACE: '0.02' },
    ))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test('agy card, thread, helper detail, slash commands, history and meter work cleanly', async () => {
    const items = await board()
    expect(items.find(i => i.key === ID)).toMatchObject({
      agent: 'agy',
      title: 'Agy Full Support',
      prompt: 'implement agy support',
      lastText: 'Done! Shall I push?',
      question: 'Done! Shall I push?',
      column: 'me',
      attention: 'question',
      context: 42000,
      model: 'gemini-4-neon-high',
      effort: 'high',
      tool: { name: 'read_file', detail: 'agy.ts', pending: false },
      helpers: { total: 1, running: 0 },
    })

    const thread = await detail(ID)
    expect(thread.conversation.map(t => [t.role, t.text ?? t.detail])).toEqual([
      ['user', 'implement agy support'],
      ['tool', 'agy.ts'],
      ['assistant', 'Done! Shall I push?'],
    ])
    expect(thread.helpers).toHaveLength(1)

    const helperRes = await fetch(`${url}/api/session/${ID}/helper/${CHILD}`)
    expect(helperRes.status).toBe(200)
    const helperJson = (await helperRes.json()) as { helper: { id: string }; conversation: Item[] }
    expect(helperJson.helper.id).toBe(CHILD)
    expect(helperJson.conversation.map(t => t.role)).toEqual(['user', 'assistant'])

    const cmdRes = await fetch(`${url}/api/session/${ID}/commands`)
    const { commands } = (await cmdRes.json()) as { commands: { name: string; source: string }[] }
    expect(commands.find(c => c.name === 'deploy-check')).toMatchObject({ source: 'project' })
    expect(commands.find(c => c.name === 'herdr-agents')).toMatchObject({ source: 'user' })
    expect(commands.find(c => c.name === 'compact')).toMatchObject({ source: 'builtin' })

    // Missing transcript & bare pane stay bare and never read Claude's files.
    for (const key of [MISSING, 'pane-a4']) {
      expect(items.find(i => i.key === key)).toMatchObject({ prompt: '', lastText: '', tool: null, column: 'idle' })
      expect((await detail(key)).conversation).toEqual([])
    }
    // Claude session unaffected.
    expect(items.find(i => i.key === CLAUDE)).toMatchObject({ agent: 'claude', lastText: 'Claude answer' })
    // Meter returns empty for agy without reading pane.
    const meter = await fetch(`${url}/api/session/${ID}/meter`)
    expect(await meter.json()).toEqual({ effort: '', model: '' })
  })

  test('agy history search, stop, rename, archive, and return work cleanly', async () => {
    const histRes = await fetch(`${url}/api/session/${WORKING}/history?q=implement`)
    expect(histRes.status).toBe(200)
    const hist = (await histRes.json()) as { results: { session: string; title: string }[] }
    expect(hist.results.some(r => r.session === ID && r.title === 'Agy Full Support')).toBe(true)

    const beforeStop = box.calls().length
    const stopRes = await post(`/api/session/${WORKING}/stop`)
    expect(stopRes.status).toBe(200)
    expect(await stopRes.json()).toEqual({ ok: true })
    const stopCalls = box
      .calls()
      .slice(beforeStop)
      .map(c => c.join(' '))
    expect(stopCalls).toContain('agent send-keys a2 esc')

    const renameRes = await post(`/api/session/${ID}/rename`, { name: 'Agy Renamed', claude: true })
    expect(renameRes.status).toBe(200)
    expect(await renameRes.json()).toEqual({ ok: true, confirmed: true })

    const archiveRes = await post(`/api/session/${ID}/archive`)
    expect(archiveRes.status).toBe(200)
    expect(await archiveRes.json()).toMatchObject({ ok: true })

    // Simulate the archive grace period having finished and return the archived agy session.
    const archiveDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'archive')
    mkdirSync(archiveDir, { recursive: true })
    const RET = '18fb0773-7c19-4e3d-8e9b-ceadaef29215'
    const retDir = join(box.dir, 'Agy дом 100%', 'brain', RET, '.system_generated', 'logs')
    mkdirSync(retDir, { recursive: true })
    writeFileSync(
      join(retDir, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-23T12:47:12Z', content: '<USER_REQUEST>\nreturned agy\n</USER_REQUEST>' })}\n`,
    )
    writeFileSync(
      join(archiveDir, `${RET}.json`),
      JSON.stringify({
        key: RET,
        session: RET,
        agent: 'agy',
        name: 'Archived Agy',
        category: 'other',
        cwd: projectDir,
        workspace: 'Work',
        pane: 'a9',
        tab: 't-old',
        state: 'archived',
        askedAt: Date.now() - 60_000,
        closeAt: Date.now() - 30_000,
        archivedAt: Date.now() - 30_000,
        by: 'user',
        held: [],
      }),
    )
    const beforeReturn = box.calls().length
    const returnRes = await post('/api/archive', { op: 'return', keys: [RET] })
    expect(returnRes.status).toBe(200)
    const deadline = Date.now() + 10_000
    let ranResume = false
    while (Date.now() < deadline) {
      const calls = box
        .calls()
        .slice(beforeReturn)
        .map(c => c.join(' '))
      if (calls.some(c => c.includes(`--conversation ${RET}`))) {
        ranResume = true
        break
      }
      await Bun.sleep(25)
    }
    expect(ranResume).toBe(true)
  })
})
