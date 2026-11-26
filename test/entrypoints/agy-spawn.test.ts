import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { agyTrustScreen } from '../support/trust-screen.ts'

const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const CLI = join(root, 'src', 'entrypoints', 'cli.ts')
const PACED = { BOARD_TEST_PACE: '0.02' }

const AGY_ID = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
const SUB_ID = '909adb87-3850-4c02-acf4-dc87166db197'
const CLAUDE_ID = '030bc85e-c173-4999-b250-c85a4d5595bd'

const AGY_READY = {
  result: {
    pane: {
      pane_id: 'wA:p9',
      tab_id: 'wA:t9',
      agent: 'agy',
      agent_status: 'idle',
      agent_session: { value: AGY_ID },
      terminal_title_stripped: 'Agy Session',
    },
  },
}

const BASE_STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, AGY_READY] },
  'agent list': { result: { agents: [] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Conversation renamed to: Agy Task\n' },
  'pane send-keys': { result: null },
}

async function runScript(box: Sandbox, script: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: root,
    env: { ...box.env, ...PACED, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

describe('spawn-agent --agent agy and board CLI Antigravity identity', () => {
  test('spawn-agent --agent agy starts without --session-id, passes --model, renames via /rename, and sends brief', async () => {
    const box = await sandbox()
    box.state(BASE_STATE)
    const dir = join(box.dir, 'Agy project')
    mkdirSync(dir)

    const r = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--name',
      'Agy Task',
      '--cwd',
      dir,
      '--workspace',
      'wA',
      '--model',
      'gemini-4-neon-high',
      '--brief',
      'Ship full support',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('pane=wA:p9 name=Agy Task agent=agy-task kind=agy')

    const calls = box.calls().map(c => c.join(' '))
    const paneRun = calls.find(c => c.startsWith('pane run wA:p9 '))
    expect(paneRun).toBe('pane run wA:p9 agy --model gemini-4-neon-high')
    expect(paneRun).not.toContain('--session-id')
    expect(calls).toContain('agent prompt wA:p9 /rename Agy Task')
    expect(calls).toContain('agent prompt wA:p9 Ship full support')
    // spawn-agent saves --model on the agy card without pinning card.name, so later renames still work (#650).
    expect(cardOf(box, AGY_ID)).toMatchObject({ modelWant: 'gemini-4-neon-high' })
    expect(cardOf(box, AGY_ID)?.name).toBeUndefined()
  })

  test('spawn-agent --agent agy moves start card category, profileWant and modelWant to the conversation card and drops the start card (#663)', async () => {
    const START_ID = '22222222-3333-4444-8555-666666666666'
    const box = await sandbox()
    box.state(BASE_STATE)
    const dir = join(box.dir, 'Agy lane project')
    mkdirSync(dir)
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(
      join(box.cards, `${START_ID}.json`),
      JSON.stringify({ key: START_ID, category: 'atlas', profileWant: 'default' }),
    )
    writeFileSync(
      join(box.cards, `${AGY_ID}.json`),
      JSON.stringify({ key: AGY_ID, agyParentClaude: false, briefV: 11 }),
    )

    const r = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--name',
      'Agy Lane',
      '--cwd',
      dir,
      '--workspace',
      'wA',
      '--session-id',
      START_ID,
      '--model',
      'gemini-4-neon-high',
      '--brief',
      'Go',
    ])
    expect(r.code, r.stderr).toBe(0)
    const paneRun = box
      .calls()
      .map(c => c.join(' '))
      .find(c => c.startsWith('pane run wA:p9 '))
    expect(paneRun).toBe('pane run wA:p9 agy --model gemini-4-neon-high')
    expect(cardOf(box, AGY_ID)).toMatchObject({
      key: AGY_ID,
      category: 'atlas',
      profileWant: 'default',
      modelWant: 'gemini-4-neon-high',
      agyParentClaude: false,
      briefV: 11,
    })
    expect(cardOf(box, AGY_ID)?.name).toBeUndefined()
    expect(cardOf(box, START_ID)).toBeNull()

    // Non-start fields keep the start card; an existing target category is not overwritten.
    const box2 = await sandbox()
    box2.state(BASE_STATE)
    const dir2 = join(box2.dir, 'Agy kept project')
    mkdirSync(dir2)
    mkdirSync(box2.cards, { recursive: true })
    writeFileSync(
      join(box2.cards, `${START_ID}.json`),
      JSON.stringify({ key: START_ID, category: 'atlas', doing: 'keep' }),
    )
    writeFileSync(join(box2.cards, `${AGY_ID}.json`), JSON.stringify({ key: AGY_ID, category: 'custom' }))

    const r2 = await runScript(box2, SPAWN, [
      '--agent',
      'agy',
      '--name',
      'Agy Kept',
      '--cwd',
      dir2,
      '--workspace',
      'wA',
      '--session-id',
      START_ID,
    ])
    expect(r2.code, r2.stderr).toBe(0)
    expect(cardOf(box2, AGY_ID)).toMatchObject({ key: AGY_ID, category: 'custom', profileWant: 'default' })
    expect(cardOf(box2, START_ID)).toMatchObject({ key: START_ID, category: 'atlas', doing: 'keep' })
  })

  test('spawn-agent --agent agy --resume uses --conversation and refuses --fork and --thread', async () => {
    const box = await sandbox()
    box.state(BASE_STATE)
    const dir = join(box.dir, 'Resume dir')
    mkdirSync(dir)
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(join(box.cards, `${AGY_ID}.json`), JSON.stringify({ key: AGY_ID, name: 'Kept Name' }))

    const resumed = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--resume',
      AGY_ID,
      '--name',
      'Resumed Agy',
      '--cwd',
      dir,
      '--workspace',
      'wA',
    ])
    expect(resumed.code).toBe(0)
    expect(cardOf(box, AGY_ID)).toMatchObject({ name: 'Kept Name' })
    const paneRun = box
      .calls()
      .map(c => c.join(' '))
      .find(c => c.startsWith('pane run wA:p9 '))
    expect(paneRun).toBe(`pane run wA:p9 agy --conversation ${AGY_ID}`)

    const forked = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--fork',
      AGY_ID,
      '--name',
      'Fork Agy',
      '--cwd',
      dir,
      '--workspace',
      'wA',
    ])
    expect(forked.code).not.toBe(0)
    expect(forked.stderr).toMatch(/--fork/i)

    const threaded = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--thread',
      't1',
      '--name',
      'Thread Agy',
      '--cwd',
      dir,
      '--workspace',
      'wA',
    ])
    expect(threaded.code).not.toBe(0)
    expect(threaded.stderr).toMatch(/--thread/i)
  })

  test('board CLI resolves ANTIGRAVITY_CONVERSATION_ID for root session, blocks subagents, and separates mixed Claude envs', async () => {
    const box = await sandbox()
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [AGY_READY.result.pane],
            tabs: [],
            workspaces: [],
          },
        },
      },
      'pane get wA:p9': AGY_READY,
    })

    // Root Antigravity session updates its own card.
    const rootRes = await runScript(box, CLI, ['doing', 'wiring agy cli'], {
      HERDR_PANE_ID: 'wA:p9',
      ANTIGRAVITY_CONVERSATION_ID: AGY_ID,
    })
    expect(rootRes.code).toBe(0)
    expect(cardOf(box, AGY_ID)).toMatchObject({ doing: 'wiring agy cli' })

    // Subagent inheriting HERDR_PANE_ID with a different ANTIGRAVITY_CONVERSATION_ID is refused.
    const subRes = await runScript(box, CLI, ['doing', 'subagent hijack'], {
      HERDR_PANE_ID: 'wA:p9',
      ANTIGRAVITY_CONVERSATION_ID: SUB_ID,
    })
    expect(subRes.code).not.toBe(0)
    expect(subRes.stderr).toMatch(/Antigravity session/i)
    expect(cardOf(box, AGY_ID)).toMatchObject({ doing: 'wiring agy cli' })
    expect(cardOf(box, SUB_ID)).toBeNull()

    // Mixed env: agy launched from a Claude terminal where agy-hook recorded agyParentClaude -> targets agy card.
    const existing = cardOf(box, AGY_ID) ?? { key: AGY_ID }
    writeFileSync(join(box.cards, `${AGY_ID}.json`), JSON.stringify({ ...existing, agyParentClaude: CLAUDE_ID }))
    const mixedAgy = await runScript(box, CLI, ['done', 'ready from agy'], {
      HERDR_PANE_ID: 'wA:p9',
      ANTIGRAVITY_CONVERSATION_ID: AGY_ID,
      CLAUDE_CODE_SESSION_ID: CLAUDE_ID,
    })
    expect(mixedAgy.code).toBe(0)
    expect(cardOf(box, AGY_ID)).toMatchObject({ result: 'ready from agy' })
    expect(cardOf(box, CLAUDE_ID)).toBeNull()

    // Real Claude child running inside an agy shell gets its own new CLAUDE_CODE_SESSION_ID -> targets Claude card.
    const OTHER_CLAUDE = '11111111-2222-3333-4444-555555555555'
    const claudeChild = await runScript(box, CLI, ['doing', 'from claude child'], {
      HERDR_PANE_ID: 'wA:p9',
      ANTIGRAVITY_CONVERSATION_ID: AGY_ID,
      CLAUDE_CODE_SESSION_ID: OTHER_CLAUDE,
    })
    expect(claudeChild.code).toBe(0)
    expect(cardOf(box, OTHER_CLAUDE)).toMatchObject({ doing: 'from claude child' })
    expect(cardOf(box, AGY_ID)).toMatchObject({ result: 'ready from agy' })
  })

  test('spawn-agent --agent agy --trust answers Antigravity folder-trust dialog and proceeds; without --trust or on another dialog it stops (#648)', async () => {
    const AGY_BLOCKED = {
      result: {
        pane: {
          pane_id: 'wA:p9',
          tab_id: 'wA:t9',
          agent: 'agy',
          agent_status: 'blocked',
          agent_session: { value: AGY_ID },
        },
      },
    }

    // 1. With --trust and Yes preselected: sends Enter, then /rename and brief.
    const box1 = await sandbox()
    const dir1 = join(box1.dir, 'Untrusted agy 100%')
    mkdirSync(dir1)
    box1.state({
      ...BASE_STATE,
      'pane get': { seq: [AGY_BLOCKED, AGY_READY] },
      'pane read': { seq: [{ text: agyTrustScreen(dir1) }, { text: 'Conversation renamed to: Trusted Agy\n' }] },
    })
    const ok1 = await runScript(box1, SPAWN, [
      '--agent',
      'agy',
      '--trust',
      '--name',
      'Trusted Agy',
      '--cwd',
      dir1,
      '--workspace',
      'wA',
      '--brief',
      'Start task',
    ])
    expect(ok1.code, ok1.stderr).toBe(0)
    const calls1 = box1.calls().map(c => c.join(' '))
    expect(calls1).toContain('pane send-keys wA:p9 enter')
    expect(calls1).toContain('agent prompt wA:p9 /rename Trusted Agy')
    expect(calls1).toContain('agent prompt wA:p9 Start task')

    // 2. With --trust and cursor on No: moves up to Yes, then sends Enter.
    const box2 = await sandbox()
    const dir2 = join(box2.dir, 'Cursor on no')
    mkdirSync(dir2)
    box2.state({
      ...BASE_STATE,
      'pane get': { seq: [AGY_BLOCKED, AGY_READY] },
      'pane read': {
        seq: [
          { text: agyTrustScreen(dir2, { selected: 'no' }) },
          { text: agyTrustScreen(dir2, { selected: 'yes' }) },
          { text: 'Conversation renamed to: Move Up\n' },
        ],
      },
    })
    const ok2 = await runScript(box2, SPAWN, [
      '--agent',
      'agy',
      '--trust',
      '--name',
      'Move Up',
      '--cwd',
      dir2,
      '--workspace',
      'wA',
      '--brief',
      'Go',
    ])
    expect(ok2.code, ok2.stderr).toBe(0)
    const keys2 = box2
      .calls()
      .map(c => c.join(' '))
      .filter(c => c.startsWith('pane send-keys'))
    expect(keys2).toEqual(['pane send-keys wA:p9 up', 'pane send-keys wA:p9 enter'])

    // 3. Without --trust: stops with "Antigravity in wA:p9 waits for a dialog", sends no keys or prompts.
    const box3 = await sandbox()
    const dir3 = join(box3.dir, 'No trust flag')
    mkdirSync(dir3)
    box3.state({
      ...BASE_STATE,
      'pane get': AGY_BLOCKED,
      'pane read': { text: agyTrustScreen(dir3) },
    })
    const stopped = await runScript(box3, SPAWN, [
      '--agent',
      'agy',
      '--name',
      'Wait Agy',
      '--cwd',
      dir3,
      '--workspace',
      'wA',
      '--brief',
      'Wait',
    ])
    expect(stopped.code).toBe(1)
    expect(stopped.stderr).toContain('Antigravity in wA:p9 waits for a dialog')
    const calls3 = box3.calls().map(c => c.join(' '))
    expect(calls3.some(c => c.startsWith('pane send-keys'))).toBe(false)
    expect(calls3.some(c => c.startsWith('agent prompt'))).toBe(false)

    // 4. With --trust, wrong folder or non-trust dialog: stops without sending keys.
    for (const screenText of [agyTrustScreen('/some/other/folder'), 'Sign in to Antigravity?\n> Yes\n  No']) {
      const box4 = await sandbox()
      const dir4 = join(box4.dir, 'Other dialog')
      mkdirSync(dir4)
      box4.state({
        ...BASE_STATE,
        'pane get': AGY_BLOCKED,
        'pane read': { text: screenText },
      })
      const refused = await runScript(box4, SPAWN, [
        '--agent',
        'agy',
        '--trust',
        '--name',
        'Refused Agy',
        '--cwd',
        dir4,
        '--workspace',
        'wA',
      ])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('Antigravity in wA:p9 waits for a dialog')
      expect(box4.calls().some(c => c[0] === 'pane' && c[1] === 'send-keys')).toBe(false)
    }
  })

  test('spawn-agent --agent agy inherits caller lane when unmatched and respects --lane (#903)', async () => {
    const box = await sandbox()
    box.state(BASE_STATE)
    const dir = join(box.dir, 'Agy unmatched')
    mkdirSync(dir)
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(join(box.cards, `${CLAUDE_ID}.json`), JSON.stringify({ key: CLAUDE_ID, category: 'agent-board' }))

    const inherited = await runScript(
      box,
      SPAWN,
      ['--agent', 'agy', '--name', 'Agy Inherited', '--cwd', dir, '--workspace', 'wA'],
      { CLAUDE_CODE_SESSION_ID: CLAUDE_ID },
    )
    expect(inherited.code, inherited.stderr).toBe(0)
    expect(cardOf(box, AGY_ID)).toMatchObject({ key: AGY_ID, category: 'agent-board', parent: CLAUDE_ID })

    const box2 = await sandbox()
    box2.state(BASE_STATE)
    const dir2 = join(box2.dir, 'Agy matched')
    mkdirSync(dir2)
    const cfgDir = join(box2.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ categories: [{ id: 'acme', title: 'Acme', color: 'blue', paths: [dir2] }] }),
    )
    const explicit = await runScript(
      box2,
      SPAWN,
      ['--agent', 'agy', '--name', 'Agy Explicit', '--cwd', dir2, '--workspace', 'wA', '--lane', 'agent-board'],
      { CLAUDE_CODE_SESSION_ID: CLAUDE_ID },
    )
    expect(explicit.code, explicit.stderr).toBe(0)
    expect(cardOf(box2, AGY_ID)).toMatchObject({ key: AGY_ID, category: 'agent-board' })
  })

  test('spawn-agent --agent agy --trust uses launch.agy flags from config.json and handles Windows trust path (#898)', async () => {
    const box = await sandbox()
    const cfgFile = join(box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(cfgFile, '..'), { recursive: true })
    writeFileSync(cfgFile, JSON.stringify({ launch: { agy: ['agy', '--dangerously-skip-permissions'] } }))

    const dir = join(box.dir, 'Win Agy')
    mkdirSync(dir)
    const AGY_BLOCKED = {
      result: {
        pane: {
          pane_id: 'wA:p9',
          tab_id: 'wA:t9',
          agent: 'agy',
          agent_status: 'blocked',
          agent_session: { value: AGY_ID },
        },
      },
    }
    box.state({
      ...BASE_STATE,
      'pane get': { seq: [AGY_BLOCKED, AGY_READY] },
      'pane read': { seq: [{ text: agyTrustScreen(dir) }, { text: 'Conversation renamed to: Win Agy\n' }] },
    })

    const r = await runScript(box, SPAWN, [
      '--agent',
      'agy',
      '--trust',
      '--name',
      'Win Agy',
      '--cwd',
      dir,
      '--workspace',
      'wA',
      '--brief',
      'Ship Windows fix',
    ])
    expect(r.code, r.stderr).toBe(0)
    const calls = box.calls().map(c => c.join(' '))
    expect(calls).toContain('pane run wA:p9 agy --dangerously-skip-permissions')
    expect(calls).toContain('pane send-keys wA:p9 enter')
    expect(calls).toContain('agent prompt wA:p9 /rename Win Agy')
    expect(calls).toContain('agent prompt wA:p9 Ship Windows fix')
  })

  test('spawnAgent prefixes MSYS_NO_PATHCONV=1 on prompt hints only on win32 with MSYSTEM (#898)', async () => {
    const AGY_BLOCKED = {
      result: {
        pane: {
          pane_id: 'wA:p9',
          tab_id: 'wA:t9',
          agent: 'agy',
          agent_status: 'blocked',
          agent_session: { value: AGY_ID },
        },
      },
    }
    const SPAWN_SVC = join(root, 'src', 'services', 'launch', 'spawn-agent.ts')
    const runBlocked = async (platform: string, extraEnv: Record<string, string>) => {
      const box = await sandbox()
      const dir = join(box.dir, 'Blocked Agy')
      mkdirSync(dir)
      box.state({ ...BASE_STATE, 'pane get': AGY_BLOCKED, 'pane read': { text: agyTrustScreen(dir) } })
      const code = `
        import { spawnAgent } from ${JSON.stringify(SPAWN_SVC)};
        try {
          await spawnAgent(
            { name: 'Win Agy', cwd: ${JSON.stringify(dir)}, workspace: 'wA', timeoutSec: 10, agent: 'agy' },
            { platform: ${JSON.stringify(platform)}, env: process.env, home: ${JSON.stringify(box.env.HOME ?? '')} },
          );
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      `
      const proc = Bun.spawn([process.execPath, '-e', code], {
        cwd: root,
        env: { ...box.env, ...PACED, ...extraEnv },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = await new Response(proc.stderr).text()
      return { code: await proc.exited, stderr }
    }

    const gitBash = await runBlocked('win32', { MSYSTEM: 'MINGW64' })
    expect(gitBash.code).toBe(1)
    expect(gitBash.stderr).toContain('MSYS_NO_PATHCONV=1 herdr agent prompt wA:p9 "/rename Win Agy"')

    const pwsh = await runBlocked('win32', {})
    expect(pwsh.code).toBe(1)
    expect(pwsh.stderr).toContain('herdr agent prompt wA:p9 "/rename Win Agy"')
    expect(pwsh.stderr).not.toContain('MSYS_NO_PATHCONV=1')

    const linux = await runBlocked('linux', { MSYSTEM: 'MINGW64' })
    expect(linux.code).toBe(1)
    expect(linux.stderr).toContain('herdr agent prompt wA:p9 "/rename Win Agy"')
    expect(linux.stderr).not.toContain('MSYS_NO_PATHCONV=1')
  })
})
