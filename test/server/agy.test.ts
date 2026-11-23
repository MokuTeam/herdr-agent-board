import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyAutoName } from '../../src/services/board.ts'
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

describe('agy card naming and subagent working status (#650)', () => {
  test('agyAutoName prefers herdr agent name, non-numeric tab label, pane label, and title over terminal title', () => {
    const shell = 'agent-board@ubuntu: ~/work/Personal/herdr/agent-board-calendar-tz'
    // Matching slug preserves spawn-agent's original capitalization from tab.label.
    expect(
      agyAutoName({
        agentName: 'gemini-calendar-zones',
        tabLabel: 'Gemini-calendar-zones',
        terminalTitle: shell,
        paneId: 'w5:pB',
      }),
    ).toBe('Gemini-calendar-zones')
    // Explicit herdr agent rename overrides an unrelated tab label.
    expect(
      agyAutoName({
        agentName: 'renamed-in-herdr',
        tabLabel: 'Old Tab',
        terminalTitle: shell,
        paneId: 'w5:pB',
      }),
    ).toBe('renamed-in-herdr')
    // Non-ASCII / spaces / % tab label matching slug keeps original spelling; uniqueSlug (-2) uses herdr name.
    expect(
      agyAutoName({
        agentName: 'zadachi-100',
        tabLabel: 'Задачи 100%',
        terminalTitle: shell,
        paneId: 'w5:pB',
      }),
    ).toBe('Задачи 100%')
    expect(
      agyAutoName({
        agentName: 'gemini-task-2',
        tabLabel: 'Gemini-task',
        terminalTitle: shell,
        paneId: 'w5:pB',
      }),
    ).toBe('gemini-task-2')
    // Non-numeric tab label wins when herdr has no agent name; paneLabel beats title when tab is numeric.
    expect(agyAutoName({ tabLabel: 'Gemini-calendar-zones', terminalTitle: shell, paneId: 'w5:pB' })).toBe(
      'Gemini-calendar-zones',
    )
    expect(
      agyAutoName({
        tabLabel: '1',
        paneLabel: 'Custom Pane',
        title: 'Conv Title',
        terminalTitle: shell,
        paneId: 'w5:pB',
      }),
    ).toBe('Custom Pane')
    // Numeric default tab label ("1") is ignored so conversation title wins over shell title.
    expect(agyAutoName({ tabLabel: '1', title: 'My Renamed Session', terminalTitle: shell, paneId: 'w5:pB' })).toBe(
      'My Renamed Session',
    )
    // Terminal title is only the last resort; whitespace-only falls back to paneId.
    expect(agyAutoName({ tabLabel: '1', terminalTitle: shell, paneId: 'w5:pB' })).toBe(shell)
    expect(agyAutoName({ tabLabel: '1', terminalTitle: '   ', paneId: 'w5:pB' })).toBe('w5:pB')
    expect(agyAutoName({ tabLabel: '1', paneId: 'w5:pB' })).toBe('w5:pB')
  })

  test('live board resolves agy names (leaving Claude, pi and Codex untouched) and marks agy working while a subagent runs', async () => {
    const sb = sharedSandbox()
    const box = await sb()
    const agyRoot = join(box.dir, 'agy-650')
    const cwd = join(box.dir, 'work')
    mkdirSync(cwd, { recursive: true })

    const ROOT_A = '28fb0773-7c19-4e3d-8e9b-ceadaef29211'
    const SUB_A = '28fb0773-7c19-4e3d-8e9b-ceadaef29299'
    const ROOT_B = '28fb0773-7c19-4e3d-8e9b-ceadaef29212'
    const KILLED_B = '28fb0773-7c19-4e3d-8e9b-ceadaef29298'
    const ROOT_C = '28fb0773-7c19-4e3d-8e9b-ceadaef29213'
    const SUB_C = '28fb0773-7c19-4e3d-8e9b-ceadaef29297'
    const CLAUDE_ID = '28fb0773-7c19-4e3d-8e9b-ceadaef29214'
    const CODEX_ID = '28fb0773-7c19-4e3d-8e9b-ceadaef29215'
    const PI_SESSION = join(box.dir, 'pi-650.jsonl')

    mkdirSync(agyRoot, { recursive: true })
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
    const ins = db.query('INSERT INTO conversation_summaries VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?)')
    const ts = '2026-11-23 18:30:00+00:00'
    const uri = JSON.stringify([`file://${cwd}`])
    ins.run(ROOT_A, 'Calendar Multi-Time Zone Support', '', ts, uri, 'CASCADE_RUN_STATUS_IDLE', '', '', 0)
    // Running subagent whose UUID herdr's hook reported on the pane!
    ins.run(SUB_A, '', '', ts, uri, 'CASCADE_RUN_STATUS_RUNNING', 'research', ROOT_A, 0)
    ins.run(ROOT_B, 'Renamed In Agy', '', ts, uri, 'CASCADE_RUN_STATUS_IDLE', '', '', 0)
    // Killed subagent must not promote ROOT_B to working.
    ins.run(KILLED_B, '', '', ts, uri, 'CASCADE_RUN_STATUS_RUNNING', 'research', ROOT_B, 1)
    ins.run(ROOT_C, '', '', ts, uri, 'CASCADE_RUN_STATUS_IDLE', '', '', 0)
    // Running subagent under a blocked root: blocked must stay blocked.
    ins.run(SUB_C, '', '', ts, uri, 'CASCADE_RUN_STATUS_RUNNING', 'research', ROOT_C, 0)
    db.close(false)

    const shell = 'agent-board@ubuntu: ~/work/Personal/herdr/agent-board-calendar-tz'
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              // Pane A: herdr reports subagent UUID + idle, tab label is spawn-agent --name, agent has matching slug.
              {
                pane_id: 'w5:pB',
                tab_id: 'w5:tB',
                workspace_id: 'w5',
                agent: 'agy',
                agent_status: 'idle',
                agent_session: { value: SUB_A },
                cwd,
                terminal_title_stripped: shell,
              },
              // Pane B: numeric default tab, no herdr agent name -> conversation title wins over shell title.
              {
                pane_id: 'w5:pC',
                tab_id: 'w5:tC',
                workspace_id: 'w5',
                agent: 'agy',
                agent_status: 'idle',
                agent_session: { value: ROOT_B },
                cwd,
                terminal_title_stripped: shell,
              },
              // Pane C: herdr agent rename differs from tab -> herdr agent name wins; blocked stays blocked despite running subagent.
              {
                pane_id: 'w5:pD',
                tab_id: 'w5:tD',
                workspace_id: 'w5',
                agent: 'agy',
                agent_status: 'blocked',
                agent_session: { value: ROOT_C },
                cwd,
                terminal_title_stripped: shell,
              },
              // Plain Claude pane: keeps terminal_title_stripped, unaffected by tab.label / agents.name.
              {
                pane_id: 'w5:pE',
                tab_id: 'w5:tE',
                workspace_id: 'w5',
                agent: 'claude',
                agent_status: 'idle',
                agent_session: { value: CLAUDE_ID },
                cwd,
                terminal_title_stripped: 'Claude Own Title',
              },
              // Plain pi pane: keeps terminal_title_stripped, unaffected by tab.label / agents.name.
              {
                pane_id: 'w5:pF',
                tab_id: 'w5:tF',
                workspace_id: 'w5',
                agent: 'pi',
                agent_status: 'idle',
                agent_session: { value: PI_SESSION },
                cwd,
                terminal_title_stripped: 'Pi Own Title',
              },
              // Plain Codex pane: keeps terminal_title_stripped, unaffected by tab.label / agents.name.
              {
                pane_id: 'w5:pG',
                tab_id: 'w5:tG',
                workspace_id: 'w5',
                agent: 'codex',
                agent_status: 'idle',
                agent_session: { value: CODEX_ID },
                cwd,
                terminal_title_stripped: 'Codex Own Title',
              },
            ],
            tabs: [
              { tab_id: 'w5:tB', workspace_id: 'w5', label: 'Gemini-calendar-zones' },
              { tab_id: 'w5:tC', workspace_id: 'w5', label: '1' },
              { tab_id: 'w5:tD', workspace_id: 'w5', label: 'Old Tab' },
              { tab_id: 'w5:tE', workspace_id: 'w5', label: 'Tab Label Should Not Override Claude' },
              { tab_id: 'w5:tF', workspace_id: 'w5', label: 'Tab Label Should Not Override Pi' },
              { tab_id: 'w5:tG', workspace_id: 'w5', label: 'Tab Label Should Not Override Codex' },
            ],
            agents: [
              { pane_id: 'w5:pB', name: 'gemini-calendar-zones' },
              { pane_id: 'w5:pD', name: 'herdr-renamed' },
              { pane_id: 'w5:pE', name: 'claude-slug' },
              { pane_id: 'w5:pF', name: 'pi-slug' },
              { pane_id: 'w5:pG', name: 'codex-slug' },
            ],
            workspaces: [{ workspace_id: 'w5', label: 'Work' }],
          },
        },
      },
      'agent get w5:pB': {
        result: {
          agent: { agent: 'agy', agent_status: 'idle', agent_session: { value: SUB_A }, name: 'gemini-calendar-zones' },
        },
      },
      'agent prompt w5:pB': { result: {} },
    })

    const { url } = await serveBoard(
      box,
      { language: 'en', launch: { agy: 'agy' } },
      { ANTIGRAVITY_APP_DATA_DIR: agyRoot, BOARD_TEST_PACE: '0.02' },
    )
    const deadline = Date.now() + 5000
    let payload: { stale: boolean; items: Item[] } = { stale: true, items: [] }
    while (payload.stale) {
      payload = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: Item[] }
      if (!payload.stale) break
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }

    // Pane A resolved SUB_A -> ROOT_A, named "Gemini-calendar-zones", promoted idle -> working with 1 running helper.
    const itemA = payload.items.find(i => i.key === ROOT_A)
    expect(itemA).toMatchObject({
      key: ROOT_A,
      session: ROOT_A,
      name: 'Gemini-calendar-zones',
      autoName: 'Gemini-calendar-zones',
      status: 'working',
      column: 'work',
      helpers: { total: 1, running: 1 },
    })
    expect(payload.items.find(i => i.key === SUB_A)).toBeUndefined()

    // Sending to ROOT_A while herdr still reports SUB_A succeeds instead of failing with sessionChanged.
    const sendRes = await fetch(`${url}/api/session/${encodeURIComponent(ROOT_A)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ session: ROOT_A, text: 'ping while subagent runs' }),
    })
    expect(sendRes.status).toBe(200)
    expect(await sendRes.json()).toMatchObject({ ok: true })

    // Pane B: conversation title beat shell title; killed subagent did not promote status.
    expect(payload.items.find(i => i.key === ROOT_B)).toMatchObject({
      name: 'Renamed In Agy',
      status: 'idle',
    })

    // Pane C: herdr agent rename beat old tab & shell title; blocked stays blocked even with a running subagent.
    expect(payload.items.find(i => i.key === ROOT_C)).toMatchObject({
      name: 'herdr-renamed',
      status: 'blocked',
    })

    // Plain Claude, pi, and Codex panes: completely untouched, keep terminal_title_stripped.
    expect(payload.items.find(i => i.key === CLAUDE_ID)).toMatchObject({
      name: 'Claude Own Title',
      autoName: 'Claude Own Title',
      status: 'idle',
    })
    expect(payload.items.find(i => i.key === PI_SESSION)).toMatchObject({
      name: 'Pi Own Title',
      autoName: 'Pi Own Title',
      status: 'idle',
    })
    expect(payload.items.find(i => i.key === CODEX_ID)).toMatchObject({
      name: 'Codex Own Title',
      autoName: 'Codex Own Title',
      status: 'idle',
    })
  }, 20_000)
})
