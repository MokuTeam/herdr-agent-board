import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Child, root, type Sandbox, sandbox, until } from '../support/sandbox.ts'

const CLAUDE_CHILD = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CLAUDE_PARENT = '1f8fad5b-d9cb-469f-a165-70867728950e'
const CODEX_ID = '2f8fad5b-d9cb-469f-a165-70867728950e'
const AGY_ID = '3f8fad5b-d9cb-469f-a165-70867728950e'
const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const PACED = { BOARD_TEST_PACE: '0.02' }

async function refreshBoard(url: string, proc: Child): Promise<Item[]> {
  const seen = proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  proc.send('refresh')
  await until(() => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length > seen)
  const body = (await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }
  return body.items
}

function claudeTranscriptPath(homeRoot: string, cwd: string, sid: string): string {
  const dir = join(homeRoot, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sid}.jsonl`)
}

function writeClaudeLine(file: string, entry: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify({ timestamp: '2026-11-23T14:00:00.000Z', ...entry })}\n`)
}

const notified = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'notification' && c[1] === 'show')

test('Claude session lost access shows on card once, notifies parent and desktop once, and clears on recovery', async () => {
  const box = await sandbox()
  const home = box.env.HOME as string
  const claudeDir = join(home, '.claude')
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
  writeFileSync(join(claudeDir, 'settings.json'), '{}')
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${CLAUDE_CHILD}.json`), JSON.stringify({ key: CLAUDE_CHILD, parent: CLAUDE_PARENT }))

  const childFile = claudeTranscriptPath(claudeDir, box.dir, CLAUDE_CHILD)
  writeClaudeLine(childFile, { type: 'user', cwd: box.dir, message: { role: 'user', content: 'run tests' } })
  writeClaudeLine(childFile, {
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Running.' }] },
  })

  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p1',
              agent: 'claude',
              agent_session: { value: CLAUDE_PARENT },
              agent_status: 'idle',
              cwd: box.dir,
              terminal_title_stripped: 'anna',
            },
            {
              pane_id: 'w1:p2',
              agent: 'claude',
              agent_session: { value: CLAUDE_CHILD },
              agent_status: 'idle',
              cwd: box.dir,
              terminal_title_stripped: 'ben',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'notification show': { result: null },
  })

  const { url, proc } = await serveBoard(box, { language: 'en' })
  try {
    let items = await refreshBoard(url, proc)
    expect(items.find(i => i.key === CLAUDE_CHILD)?.column).toBe('idle')
    expect(notified(box)).toEqual([])

    // Child hits usage limit with reset time.
    writeClaudeLine(childFile, {
      type: 'assistant',
      timestamp: '2026-11-23T14:02:00.000Z',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your limit · resets 6pm (UTC)" }],
      },
    })

    items = await refreshBoard(url, proc)
    const child = items.find(i => i.key === CLAUDE_CHILD)
    expect(child?.column).toBe('me')
    expect(child?.attention).toBe('access')
    expect(child?.question).toMatch(/^limit until /)
    expect(notified(box)).toHaveLength(1)

    // Parent received one scheduled notice.
    const sched = (await (await fetch(`${url}/api/board`)).json()) as {
      schedules: { key: string; text: string; by?: string }[]
    }
    expect(sched.schedules.filter(s => s.key === CLAUDE_PARENT && s.by === 'lost-access')).toHaveLength(1)
    expect(sched.schedules.find(s => s.key === CLAUDE_PARENT && s.by === 'lost-access')?.text).toMatch(
      /^ben lost access: limit until /,
    )

    // Second refresh does NOT repeat notifications.
    await refreshBoard(url, proc)
    expect(notified(box)).toHaveLength(1)

    // Next successful turn clears the card back to idle.
    writeClaudeLine(childFile, {
      type: 'assistant',
      timestamp: '2026-11-23T18:05:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'All tests pass.' }] },
    })
    items = await refreshBoard(url, proc)
    const recovered = items.find(i => i.key === CLAUDE_CHILD)
    expect(recovered?.column).toBe('idle')
    expect(recovered?.attention).toBe('')
    expect(recovered?.lostAccess).toBeUndefined()
  } finally {
    proc.kill()
    await proc.exited
  }
})

test('multi-profile 401 names the profile; single-profile omits it; transient 529 and agy stay unchanged', async () => {
  const box = await sandbox()
  const home = box.env.HOME as string
  const defDir = join(home, '.claude')
  const workDir = join(home, '.claude-work')
  mkdirSync(join(defDir, 'sessions'), { recursive: true })
  mkdirSync(join(workDir, 'sessions'), { recursive: true })
  writeFileSync(join(defDir, 'settings.json'), '{}')
  writeFileSync(join(workDir, 'settings.json'), '{}')
  mkdirSync(box.cards, { recursive: true })

  const workSid = '4f8fad5b-d9cb-469f-a165-70867728950e'
  const err529Sid = '5f8fad5b-d9cb-469f-a165-70867728950e'
  writeFileSync(
    join(box.cards, `${workSid}.json`),
    JSON.stringify({ key: workSid, profile: 'work', profileDir: workDir }),
  )
  writeFileSync(
    join(box.cards, `${err529Sid}.json`),
    JSON.stringify({ key: err529Sid, profile: 'default', profileDir: defDir }),
  )

  const workFile = claudeTranscriptPath(workDir, box.dir, workSid)
  writeClaudeLine(workFile, {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 401 unauthorized' }],
    },
  })

  const file529 = claudeTranscriptPath(defDir, box.dir, err529Sid)
  writeClaudeLine(file529, {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
    },
  })

  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p1',
              agent: 'claude',
              agent_session: { value: workSid },
              agent_status: 'done',
              cwd: box.dir,
            },
            {
              pane_id: 'w1:p2',
              agent: 'claude',
              agent_session: { value: err529Sid },
              agent_status: 'done',
              cwd: box.dir,
            },
            { pane_id: 'w1:p3', agent: 'agy', agent_session: { value: AGY_ID }, agent_status: 'idle', cwd: box.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'notification show': { result: null },
  })

  // Both profiles shown: Work profile is named in the logged-out card line.
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    profiles: [
      { id: 'default', title: 'Default', dir: defDir, hidden: false },
      { id: 'work', title: 'Work', dir: workDir, hidden: false },
    ],
  })
  try {
    const items = await refreshBoard(url, proc)
    const workItem = items.find(i => i.key === workSid)
    expect(workItem?.column).toBe('me')
    expect(workItem?.attention).toBe('access')
    expect(workItem?.question).toBe('logged out of the Work profile')

    // Transient 529 stays in done (not Needs me) and sends no lost-access notification.
    const item529 = items.find(i => i.key === err529Sid)
    expect(item529?.column).toBe('done')
    expect(item529?.attention).toBe('')
    expect(item529?.lostAccess).toBeUndefined()

    // agy session stays idle and untouched.
    const agyItem = items.find(i => i.key === AGY_ID)
    expect(agyItem?.column).toBe('idle')
    expect(agyItem?.attention).toBe('')
    expect(notified(box)).toHaveLength(1)
  } finally {
    proc.kill()
    await proc.exited
  }

  // Single-profile setup: omits profile name for default profile.
  const boxSingle = await sandbox()
  const singleDir = join(boxSingle.env.HOME as string, '.claude')
  mkdirSync(join(singleDir, 'sessions'), { recursive: true })
  writeFileSync(join(singleDir, 'settings.json'), '{}')
  const singleSid = '6f8fad5b-d9cb-469f-a165-70867728950e'
  mkdirSync(boxSingle.cards, { recursive: true })
  writeFileSync(
    join(boxSingle.cards, `${singleSid}.json`),
    JSON.stringify({ key: singleSid, profile: 'default', profileDir: singleDir }),
  )
  writeClaudeLine(claudeTranscriptPath(singleDir, boxSingle.dir, singleSid), {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 401 unauthorized' }],
    },
  })
  boxSingle.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p1',
              agent: 'claude',
              agent_session: { value: singleSid },
              agent_status: 'idle',
              cwd: boxSingle.dir,
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'notification show': { result: null },
  })
  const singleSrv = await serveBoard(boxSingle, { language: 'en' })
  try {
    const items = await refreshBoard(singleSrv.url, singleSrv.proc)
    expect(items.find(i => i.key === singleSid)?.question).toBe('logged out')
  } finally {
    singleSrv.proc.kill()
    await singleSrv.proc.exited
  }
})

test('Codex and pi sessions surface lost access and self-clear on recovery', async () => {
  const box = await sandbox()
  const home = box.env.HOME as string
  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '23')
  mkdirSync(codexDir, { recursive: true })
  const codexFile = join(codexDir, `rollout-2026-11-23T14-00-00-${CODEX_ID}.jsonl`)
  writeFileSync(
    codexFile,
    `${JSON.stringify({
      timestamp: '2026-11-23T14:01:00Z',
      type: 'event_msg',
      payload: { type: 'error', message: '401 Unauthorized', codex_error_info: { http_status_code: 401 } },
    })}\n`,
  )

  const piDir = join(home, '.pi', 'agent', 'sessions', '--w--')
  mkdirSync(piDir, { recursive: true })
  const piFile = join(piDir, '2026-11-23T14-00-00Z_p1.jsonl')
  writeFileSync(
    piFile,
    `${[
      JSON.stringify({ type: 'session', version: 3, id: 'p1', timestamp: '2026-11-23T14:00:00Z', cwd: box.dir }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-11-23T14:01:00Z',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'OAuth token expired' },
      }),
    ].join('\n')}\n`,
  )

  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p1',
              agent: 'codex',
              agent_session: { value: CODEX_ID },
              agent_status: 'idle',
              cwd: box.dir,
            },
            { pane_id: 'w1:p2', agent: 'pi', agent_session: { value: piFile }, agent_status: 'idle', cwd: box.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'notification show': { result: null },
  })

  const { url, proc } = await serveBoard(box, { language: 'en' })
  try {
    let items = await refreshBoard(url, proc)
    expect(items.find(i => i.key === CODEX_ID)).toMatchObject({
      column: 'me',
      attention: 'access',
      question: 'logged out',
    })
    expect(items.find(i => i.key === piFile)).toMatchObject({
      column: 'me',
      attention: 'access',
      question: 'expired login',
    })
    expect(notified(box)).toHaveLength(2)

    // Both recover on next successful turn
    appendFileSync(
      codexFile,
      `${JSON.stringify({
        timestamp: '2026-11-23T14:05:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      })}\n`,
    )
    appendFileSync(
      piFile,
      `${JSON.stringify({
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-11-23T14:05:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' },
      })}\n`,
    )
    items = await refreshBoard(url, proc)
    expect(items.find(i => i.key === CODEX_ID)?.column).toBe('idle')
    expect(items.find(i => i.key === piFile)?.column).toBe('idle')
  } finally {
    proc.kill()
    await proc.exited
  }
})

test('spawn-agent records caller parent on child card for lost-access notification', async () => {
  const box = await sandbox()
  const home = box.env.HOME as string
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  box.state({
    'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
    'tab rename': { result: null },
    'pane run': { result: null },
    'pane get': { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } },
    'agent list': { result: { agents: [{ pane_id: 'wA:p9' }] } },
    'agent rename': { result: null },
    'agent prompt': { result: null },
    'pane read': { text: 'Session renamed to: ben' },
    'pane send-keys': { result: null },
  })
  const proc = Bun.spawn(
    [process.execPath, SPAWN, '--name', 'ben', '--cwd', box.dir, '--workspace', 'wA', '--session-id', CLAUDE_CHILD],
    {
      cwd: root,
      env: { ...box.env, ...PACED, CLAUDE_CODE_SESSION_ID: CLAUDE_PARENT },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const code = await proc.exited
  expect(code).toBe(0)
  const saved = JSON.parse(await Bun.file(join(box.cards, `${CLAUDE_CHILD}.json`)).text()) as Record<string, unknown>
  expect(saved.parent).toBe(CLAUDE_PARENT)
})
