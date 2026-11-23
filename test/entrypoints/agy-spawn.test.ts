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
  })

  test('spawn-agent --agent agy --resume uses --conversation and refuses --fork and --thread', async () => {
    const box = await sandbox()
    box.state(BASE_STATE)
    const dir = join(box.dir, 'Resume dir')
    mkdirSync(dir)

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
})
