import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { MIGRATIONS } from '../../src/adapters/db-schema.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { workdeskTask } from '../../src/core/workdesk.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { stateDir } from '../support/sleeper-fixtures.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

test('Workdesk dialog discovery is independent of W1 and publishes only safe waiting state', async () => {
  const box = await sandbox()
  const fake = mcp(box.dir)
  const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
  const privateText = 'synthetic owner dialogue: never visible'
  fake.write({
    tasks: [],
    dialog: {
      assignment,
      task: 7,
      revision: 1,
      delivered: 0,
      events: [
        {
          id: 3,
          board_task_id: 7,
          assignment_id: assignment,
          revision: 1,
          executor: null,
          board_status: 'queued',
          kind: 'message',
          created_at: 1,
          text: privateText,
        },
      ],
      messages: [],
    },
  })
  const { url } = await serveBoard(box, { threads: true, workdesk: fake.config, workdeskDialog: { onlyTaskId: 7 } })
  const body = async () => (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  expect((await body()).workdeskDialog).toBeDefined()
  let payload = await body()
  for (let i = 0; i < 100 && payload.workdeskDialog?.pending !== 1; i++) {
    await Bun.sleep(20)
    payload = await body()
  }
  expect(payload.workdeskDialog).toEqual({
    delivery: 'awaiting_recipient',
    pending: 1,
    more: false,
    polledAt: expect.any(Number),
    problem: null,
    blocked: { awaiting_claim: 1 },
  })
  expect(JSON.stringify(payload)).not.toContain(privateText)
  expect(JSON.stringify(payload)).not.toContain(assignment)
  expect(payload.workdesk).toBeDefined()
  expect(
    fake
      .calls()
      .filter(call => call.method === 'tools/call' && call.params.name?.includes('owner_'))
      .map(call => call.params.name),
  ).toEqual(['list_owner_events'])
  const forged = await fetch(`${url}/api/workdesk/owner-messages?session=forged-SID&task_id=7`, {
    headers: { 'X-Board-Session': 'forged-SID' },
  })
  expect(forged.status).toBe(404)
  expect(await forged.text()).not.toContain(privateText)
})

test('ordinary Web and CLI thread views only expose a generic update, even with a selected SID', async () => {
  const box = await sandbox()
  const sid = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
  const name = 'Board-codex-master'
  const pane = {
    pane_id: 'dialog-pane',
    cwd: box.dir,
    terminal_title_stripped: name,
    agent: 'codex',
    agent_status: 'idle',
    agent_session: { value: sid },
  }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get dialog-pane': { result: { agent: pane } },
    'agent read dialog-pane': { text: '› \n  gpt-6.2-sol · 100%' },
  })
  const fake = mcp(box.dir)
  const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
  const privateText = 'another synthetic body [board reminder]'
  fake.write({
    tasks: [{ ...task(7), assignment_id: assignment, revision: 1 }],
    dialog: {
      assignment,
      task: 7,
      revision: 1,
      executor: name,
      delivered: 0,
      events: [
        {
          id: 3,
          board_task_id: 7,
          assignment_id: assignment,
          revision: 1,
          executor: null,
          board_status: 'queued',
          kind: 'message',
          created_at: 1,
        },
      ],
      messages: [
        { id: 3, revision: 1, kind: 'message', text: privateText, question_id: null, option_id: null, created_at: 1 },
      ],
    },
  })
  const { url } = await serveBoard(box, {
    threads: true,
    workdesk: fake.config,
    workdeskDialog: { intervalSec: 1 },
  })
  const readStatus = async () => ((await (await fetch(`${url}/api/board`)).json()) as BoardPayload).workdeskDialog
  let status = await readStatus()
  for (let i = 0; i < 250 && status?.blocked.protected_delivery_unavailable !== 1; i++) {
    await Bun.sleep(10)
    status = await readStatus()
  }
  expect(status?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  const thread = rows(join(stateDir(box), 'board.db'))[0]
  if (!thread) throw new Error('missing synthetic W1 thread')
  const web = await fetch(`${url}/api/threads/${thread.key}?full=1&session=${sid}`)
  expect(web.status).toBe(200)
  const config = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'config.json'), JSON.stringify({ threads: true }))
  const cli = await box.run('cli', { args: ['--session', sid, 'thread', 'show', thread.key, '--full'], env: {} }).exited
  expect(cli.code).toBe(0)
  for (const output of [await web.text(), cli.stdout]) {
    expect(output).toContain('обновление диалога')
    expect(output).not.toContain(privateText)
  }
  expect(fake.calls('read_owner_messages')).toEqual([])
  expect(fake.calls('ack_owner_messages')).toEqual([])
})

test('the normal server accepts a pinned recipient only on its launcher IPC and ACKs sealed data', async () => {
  const box = await sandbox()
  const sid = '018f5280-4ef2-42e8-9b0f-4517daaf0d37'
  const other = '018f5280-4ef2-42e8-9b0f-4517daaf0d38'
  const name = 'Board-codex-master'
  const pane = {
    pane_id: 'dialog-pane',
    cwd: box.dir,
    terminal_title_stripped: name,
    agent: 'codex',
    agent_status: 'idle',
    agent_session: { value: sid },
  }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get dialog-pane': { result: { agent: pane } },
    'agent read dialog-pane': { text: '› \n  gpt-6.2-sol · 100%' },
    'agent prompt dialog-pane': { result: {} },
  })
  const fake = mcp(box.dir)
  const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
  const card = { ...task(7), assignment_id: assignment, revision: 1, executor: name, status: 'doing' }
  const dbPath = join(stateDir(box), 'board.db')
  const db = openDb({ path: dbPath, steps: MIGRATIONS.filter(step => step.version <= 6) })
  const parsed = workdeskTask(card)
  if (!db || !parsed) throw new Error('invalid synthetic handoff')
  const target = { key: sid, sid, name, lane: 'board' }
  const store = workdeskStore(db)
  store.reserve(7, target)
  store.handoff(parsed, target, Date.now())
  const threadId = store.find(7)?.thread_id
  db.close()
  if (!threadId) throw new Error('missing synthetic thread')
  const secret = 'synthetic author body that stays outside the thread'
  fake.write({
    tasks: [card],
    dialog: {
      assignment,
      task: 7,
      revision: 1,
      executor: name,
      delivered: 0,
      events: [
        {
          id: 3,
          board_task_id: 7,
          assignment_id: assignment,
          revision: 1,
          executor: name,
          board_status: 'doing',
          kind: 'message',
          created_at: 1,
        },
      ],
      messages: [
        { id: 3, revision: 1, kind: 'message', text: secret, question_id: null, option_id: null, created_at: 1 },
      ],
    },
  })
  const { url, proc } = await serveBoard(box, {
    threads: true,
    workdesk: fake.config,
    scheduleTickSec: 0.2,
    workdeskDialog: {
      intervalSec: 1,
      onlyTaskId: 7,
      receiver: 'launcher',
      deliver: true,
      legacyBindings: [{ taskId: 7, assignmentId: assignment, threadId, sessionId: sid }],
    },
  })
  async function ipc(id: number, payload: Record<string, unknown>): Promise<unknown> {
    proc.send({ id, kind: 'workdesk-dialog', ...payload })
    for (let i = 0; i < 200; i++) {
      const result = proc.messages.find(
        m => !!m && typeof m === 'object' && 'id' in m && m.id === id && 'kind' in m && m.kind === 'workdesk-dialog',
      ) as { result: unknown } | undefined
      if (result) return result.result
      await Bun.sleep(10)
    }
    throw new Error('private reply unavailable')
  }
  const sealingKey = randomBytes(32).toString('base64url')
  const attach = (id: string, readOnly: boolean) => ({
    op: 'attach',
    sealingKey,
    readOnly,
    session: { thread: { id } },
  })
  const board = async () => (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  expect(await ipc(701, attach(other, false))).toBe(false)
  expect(await ipc(707, attach(sid, true))).toBe(true)
  expect((await board()).workdeskDialog).toMatchObject({ delivery: 'recipient_attached', deliverEnabled: false })
  expect(await ipc(708, { op: 'tool', request: {} })).toBeNull()
  for (let i = 0; i < 200 && (await board()).workdeskDialog?.blocked.protected_delivery_unavailable !== 1; i++)
    await Bun.sleep(10)
  expect((await board()).workdeskDialog?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  expect(fake.calls('read_owner_messages')).toEqual([])
  expect(fake.calls('ack_owner_messages')).toEqual([])
  expect(await ipc(702, attach(sid, false))).toBe(true)
  for (let i = 0; i < 275 && fake.calls('ack_owner_messages').length === 0; i++) await Bun.sleep(10)
  expect(fake.calls('ack_owner_messages')).toHaveLength(1)
  const call = (threadId: string) => ({
    id: 1,
    method: 'item/tool/call',
    params: { threadId, tool: 'read_workdesk_dialog', arguments: {} },
  })
  expect(await ipc(703, { op: 'tool', request: call(other) })).toMatchObject({ result: { success: false } })
  expect(JSON.stringify(await ipc(704, { op: 'tool', request: call(sid) }))).toContain(secret)
  expect((await board()).workdeskDialog).toMatchObject({
    pending: 0,
    delivery: 'recipient_attached',
    deliverEnabled: true,
  })
  const thread = rows(dbPath)[0]
  expect(await (await fetch(`${url}/api/threads/${thread?.key}?full=1`)).text()).not.toContain(secret)
  const reminders = () =>
    box
      .calls()
      .filter(
        call =>
          call[0] === 'agent' &&
          call[1] === 'prompt' &&
          String(call[3]).includes('Для текста вызови защищённое чтение Workdesk'),
      )
  await until(() => reminders().length === 1)
  expect(reminders()[0]?.[2]).toBe('dialog-pane')
  expect(JSON.stringify(box.calls())).not.toContain(secret)
  await ipc(705, { op: 'detach' })
  expect(await ipc(706, { op: 'tool', request: call(sid) })).toBeNull()
}, 12_000)
