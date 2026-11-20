import { expect, onTestFinished, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import { entriesOf, getThread } from '../../src/adapters/work-thread-store.ts'
import { type ProtectedDialogSink, workdeskDialogStore } from '../../src/adapters/workdesk-dialog-store.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import { workdeskTask } from '../../src/core/workdesk.ts'
import type { DialogTarget, OwnerEvent, OwnerMessage } from '../../src/core/workdesk-dialog.ts'
import { createWorkdeskDialog } from '../../src/services/workdesk-dialog.ts'
import { createWorkdeskDialogSession } from '../../src/services/workdesk-dialog-session.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const SID = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
const OTHER = '018f5280-4ef2-42e8-9b0f-4517daaf0d38'
const ASSIGNMENT = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
const STALE = 'a1f42fcb-9183-41d0-b577-030828bf5e89'
const NAME = 'Board-codex-master'
const MASTER = { key: SID, name: NAME, lane: 'board', sid: SID }

const item: Item = {
  name: NAME,
  key: SID,
  session: SID,
  pane: 'p1',
  cwd: '',
  workspace: null,
  category: 'board',
  categorySet: true,
  autoName: '',
  status: 'idle',
  column: 'idle',
  attention: '',
  agent: 'codex',
}

const privateText = 'Только владельцу и исполнителю: [board reminder] $() --session'
const ownerMessage = (id: number, kind: OwnerMessage['kind'], revision = 1): OwnerMessage => ({
  id,
  kind,
  revision,
  text: privateText,
  created_at: id,
  question_id: kind === 'choice' ? 2 : null,
  option_id: kind === 'choice' ? 'o2' : null,
})
const event = (message: OwnerMessage, overrides: Partial<OwnerEvent> = {}): OwnerEvent => ({
  id: message.id,
  revision: message.revision,
  kind: message.kind,
  created_at: message.created_at,
  board_task_id: 1,
  assignment_id: ASSIGNMENT,
  executor: NAME,
  board_status: 'done',
  ...overrides,
})
const rawTask = { ...task(1), assignment_id: ASSIGNMENT, revision: 1 }
function withDb<T>(read: (db: BoardDb) => T): T {
  const db = openDb()
  if (!db) throw new Error('expected sandbox database')
  try {
    return read(db)
  } finally {
    db.close()
  }
}
function handoff(v2 = true): string {
  return withDb(db => {
    const assignment = workdeskTask({ ...(v2 ? rawTask : task(1)), executor: NAME, status: 'doing' })
    if (!assignment) throw new Error('bad fixture task')
    const store = workdeskStore(db)
    store.reserve(1, MASTER)
    store.handoff(assignment, MASTER, 1)
    const id = store.find(1)?.thread_id
    if (!id) throw new Error('missing fixture handoff')
    return id
  })
}

function fixture(messages: OwnerMessage[], events = messages.map(message => event(message))) {
  const fake = mcp(isolatedHome())
  const dialog = {
    events,
    messages,
    task: 1,
    assignment: ASSIGNMENT,
    executor: NAME,
    delivered: 0,
    revision: messages.at(-1)?.revision ?? 1,
  }
  fake.write({ tasks: [], dialog })
  const cfg = normalizeConfig({ threads: true, workdesk: fake.config, workdeskDialog: {} })
  let items: readonly Item[] | null = [item]
  const start = (sink?: ProtectedDialogSink) => {
    const service = createWorkdeskDialog({ cfg, items: () => items, onChange() {}, ...(sink && { sink }) })
    onTestFinished(() => service.stop())
    service.configChanged()
    return service
  }
  async function tick(sink?: ProtectedDialogSink) {
    const poller = start(sink)
    await until(() => !!poller.view()?.polledAt)
    await poller.stop()
    return poller.view()
  }
  return {
    fake,
    dialog,
    cfg,
    start,
    tick,
    items: (next: readonly Item[] | null) => {
      items = next
    },
  }
}

function protectedFixture() {
  withDb(db => db.db.exec('CREATE TABLE synthetic_reader (assignment TEXT, sid TEXT, body TEXT) STRICT'))
  // Models a pre-authenticated test harness. There is no production implementation of this sink.
  let caller = SID
  const sink: ProtectedDialogSink = {
    permits: target => target.sid === caller,
    stage: (tx, target, message) => {
      tx.db
        .query('INSERT INTO synthetic_reader VALUES (?, ?, ?)')
        .run(target.assignment_id, target.sid, JSON.stringify(message))
    },
    contains(tx, target, message) {
      return !!tx.db
        .query('SELECT 1 FROM synthetic_reader WHERE assignment = ? AND sid = ? AND body = ?')
        .get(target.assignment_id, target.sid, JSON.stringify(message))
    },
  }
  return {
    sink,
    caller: (sid: string) => {
      caller = sid
    },
    bodies: () =>
      withDb(db =>
        db.db
          .query<{ body: string }, []>('SELECT body FROM synthetic_reader ORDER BY rowid')
          .all()
          .map(row => JSON.parse(row.body) as OwnerMessage),
      ),
  }
}

test('dialog stays off by default; an older catalogue or a denied board role makes no owner message read', async () => {
  const f = fixture([])
  delete f.cfg.workdeskDialog
  const disabled = f.start()
  expect(disabled.view()).toBeNull()
  expect(f.fake.calls()).toEqual([])
  expect(existsSync(dbFile())).toBe(false)
  await disabled.stop()

  f.cfg.workdeskDialog = {}
  f.fake.write({ tasks: [] })
  expect((await f.tick())?.problem).toBe('tools')
  expect(f.fake.calls().filter(call => call.method === 'tools/call')).toEqual([])
  expect(existsSync(dbFile())).toBe(false)

  f.fake.write({ tasks: [], dialog: { ...f.dialog, deny: 'list_owner_events' } })
  expect((await f.tick())?.problem).toBe('role_denied')
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
})

test('commits metadata pages, retains before claim and offline, and attaches one generic notice after W1 claim', async () => {
  const messages = [ownerMessage(3, 'message'), ownerMessage(12, 'choice'), ownerMessage(24, 'message')]
  const f = fixture(
    messages,
    messages.map(m => event(m, { executor: null, board_status: 'queued' })),
  )
  f.fake.write({ tasks: [], dialog: { ...f.dialog, pageSize: 1 } })
  const pollers = [f.start(), f.start()]
  await until(() => pollers.every(poller => poller.view()?.pending === 3))
  expect(pollers[0]?.view()?.blocked).toEqual({ awaiting_claim: 3 })
  await Promise.all(pollers.map(poller => poller.stop()))
  expect(withDb(db => workdeskDialogStore(db, () => []).cursor())).toBe(24)
  expect(rows()).toEqual([])

  f.fake.write({ tasks: [rawTask], topology: true, dialog: f.dialog })
  f.cfg.workdesk = { ...f.fake.config, topology: { deviceId: 'synthetic' } }
  const w1 = createWorkdeskWatcher({
    cfg: f.cfg,
    items: () => [item],
    observation: () => ({ items: [item], observedAt: Date.now() }),
    onChange() {},
    log() {},
  })
  onTestFinished(() => w1.stop())
  w1.configChanged()
  await until(() => !!w1.view()?.polledAt)
  await w1.stop()
  const id = rows()[0]?.id
  if (!id) throw new Error('no W1 thread')
  expect(f.fake.calls('claim_task')).toHaveLength(1)
  expect(f.fake.calls('board_heartbeat')[0]?.params.arguments).toMatchObject({ topology: { version: 1 } })
  f.items(null)
  expect((await f.tick())?.blocked).toEqual({ session_unavailable: 3 })
  f.items([item])
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 3 })
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 3 })
  const feed = withDb(db => entriesOf(db, id))
  expect(feed.filter(entry => entry.text.includes('обновление диалога'))).toHaveLength(1)
  expect(JSON.stringify(feed)).not.toContain(privateText)
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(f.fake.calls('list_owner_events').at(-1)?.params.arguments).toMatchObject({ after: 24 })
  expect(rows()).toHaveLength(1)
})

test('rejects invalid discovery cursors and rolls back both the page and cursor if interrupted before commit', async () => {
  const f = fixture([ownerMessage(3, 'message')])
  f.fake.write({ tasks: [], dialog: { ...f.dialog, invalidList: true } })
  expect(await f.tick()).toMatchObject({ problem: 'invalid_page', pending: 0 })
  withDb(db => {
    const broken: BoardDb = {
      ...db,
      write: (by, fn) =>
        db.write(by, tx => {
          fn(tx)
          throw new Error('process exited before commit')
        }),
    }
    const store = workdeskDialogStore(db, () => [])
    expect(() => workdeskDialogStore(broken, () => []).retain(0, f.dialog.events, 3)).toThrow('process exited')
    expect(store.cursor()).toBe(0)
    expect(store.pending()).toEqual([])
  })
  f.fake.write({ tasks: [], dialog: f.dialog })
  expect(await f.tick()).toMatchObject({ problem: null, pending: 1 })
  expect((await f.tick())?.pending).toBe(1)
  expect(withDb(db => workdeskDialogStore(db, () => []).cursor())).toBe(3)
})

test('a protected sink rolls back on partial delivery, then recovers before and after remote ACK without duplicate receipts', async () => {
  const messages = [ownerMessage(3, 'message'), ownerMessage(12, 'choice'), ownerMessage(24, 'rework', 2)]
  const f = fixture(messages)
  const id = handoff()
  withDb(db => db.db.query("UPDATE threads SET status = 'done' WHERE id = ?").run(id))
  const reader = protectedFixture()
  reader.caller(OTHER)
  expect((await f.tick(reader.sink))?.blocked).toEqual({ protected_delivery_unavailable: 3 })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  reader.caller(SID)
  expect(
    (
      await f.tick({
        ...reader.sink,
        stage(tx, target, message) {
          reader.sink.stage(tx, target, message)
          if (message.id === 12) throw new Error('process exited during delivery')
        },
      })
    )?.blocked,
  ).toEqual({ protected_delivery_failed: 3 })
  expect(reader.bodies()).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])

  for (const dropAck of ['before', 'after'] as const) {
    f.fake.write({ tasks: [], dialog: { ...f.dialog, dropAck } })
    expect((await f.tick(reader.sink))?.blocked).toEqual({ ack: 3 })
    expect(reader.bodies()).toEqual(messages)
    expect(
      withDb(db => db.db.query('SELECT thread_id, sid, revision, acknowledged FROM workdesk_dialog_bindings').get()),
    ).toEqual({ thread_id: id, sid: SID, revision: 2, acknowledged: 0 })
  }
  expect((await f.tick(reader.sink))?.pending).toBe(0)
  expect((await f.tick(reader.sink))?.pending).toBe(0)
  expect(reader.bodies()).toEqual(messages)
  expect(f.fake.calls('read_owner_messages').map(call => call.params.arguments)).toEqual(
    Array.from({ length: 4 }, () => ({ task_id: 1, assignment_id: ASSIGNMENT, executor: NAME, after: 0 })),
  )
  expect(f.fake.calls('ack_owner_messages').map(call => call.params.arguments)).toEqual(
    Array.from({ length: 2 }, () => ({ task_id: 1, assignment_id: ASSIGNMENT, executor: NAME, through: 24 })),
  )
  expect(f.fake.calls('claim_task')).toEqual([])
  expect(withDb(db => db.db.query('SELECT acknowledged FROM workdesk_dialog_bindings').get())).toEqual({
    acknowledged: 24,
  })
  expect(withDb(db => getThread(db, id)?.status)).toBe('done')
  expect(withDb(db => JSON.stringify(entriesOf(db, id)))).not.toContain(privateText)
  expect(withDb(db => JSON.stringify(db.db.query('SELECT * FROM journal').all()))).not.toContain(privateText)
  expect(rows().map(row => row.id)).toEqual([id])
})

test('the ACK prefix cannot skip a known message even when global IDs are sparse', async () => {
  const f = fixture([ownerMessage(3, 'message'), ownerMessage(12, 'choice'), ownerMessage(24, 'message')])
  handoff()
  const reader = protectedFixture()
  f.fake.write({ tasks: [], dialog: { ...f.dialog, omitMessage: 12 } })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ invalid_page: 3 })
  expect(reader.bodies()).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
})

test('ambiguous assignment, renamed executor, changed thread and SID keep events pending without protected reads', async () => {
  const message = ownerMessage(3, 'message')
  const f = fixture(
    [message],
    [
      event(message),
      event(ownerMessage(12, 'message'), { assignment_id: STALE }),
      event(ownerMessage(24, 'message'), { executor: 'Other master' }),
    ],
  )
  const thread = handoff()
  const reader = protectedFixture()
  expect((await f.tick(reader.sink))?.blocked).toEqual({ assignment_mismatch: 1, executor_changed: 2 })
  expect(reader.bodies()).toEqual([])
  withDb(db => db.db.query('DELETE FROM workdesk_dialog_events WHERE id = 24').run())

  f.items([{ ...item, session: OTHER }])
  expect((await f.tick(reader.sink))?.blocked).toEqual({ assignment_mismatch: 1, session_unavailable: 1 })
  f.items([item])
  withDb(db =>
    db.db
      .query('UPDATE threads SET assignee = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'session', key: OTHER, name: NAME }), thread),
  )
  expect((await f.tick(reader.sink))?.blocked).toEqual({ assignment_mismatch: 1, thread_reassigned: 1 })
  withDb(db =>
    db.write('test', ({ db: sql }) => {
      sql.query('DELETE FROM thread_entries WHERE thread = ?').run(thread)
      sql.query('DELETE FROM threads WHERE id = ?').run(thread)
    }),
  )
  expect((await f.tick(reader.sink))?.blocked).toEqual({ assignment_mismatch: 1, thread_missing: 1 })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(rows()).toEqual([])
})

test('a pre-v2 handoff cannot be backfilled from an event and executor name', async () => {
  const f = fixture([ownerMessage(3, 'message')])
  handoff(false)
  expect((await f.tick())?.blocked).toEqual({ assignment_unverified: 1 })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
})

test('a new metadata rework updates the original assignment and thread even while protected delivery is unavailable', async () => {
  const f = fixture([ownerMessage(3, 'rework', 2)])
  const thread = handoff()
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  expect(
    withDb(db => db.db.query('SELECT assignment_id, revision, thread_id FROM workdesk_dialog_bindings').get()),
  ).toEqual({ assignment_id: ASSIGNMENT, revision: 2, thread_id: thread })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(f.fake.calls('claim_task')).toEqual([])
})

test('does not acknowledge messages beyond the current durable discovery page limit', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ownerMessage(2 * i + 1, 'message'))
  const f = fixture(messages)
  handoff()
  const reader = protectedFixture()
  f.fake.write({ tasks: [], dialog: { ...f.dialog, pageSize: 1 } })
  expect(await f.tick(reader.sink)).toMatchObject({ pending: 0, more: true })
  expect(reader.bodies()).toEqual(messages.slice(0, 10))
  expect(await f.tick(reader.sink)).toMatchObject({ pending: 0, more: false })
  expect(reader.bodies()).toEqual(messages)
  expect(f.fake.calls('ack_owner_messages').map(call => call.params.arguments)).toEqual([
    { task_id: 1, assignment_id: ASSIGNMENT, executor: NAME, through: 19 },
    { task_id: 1, assignment_id: ASSIGNMENT, executor: NAME, through: 23 },
  ])
})

test('SID change during a protected read prevents staging and ACK', async () => {
  const f = fixture([ownerMessage(3, 'message')])
  handoff()
  const reader = protectedFixture()
  f.fake.write({ tasks: [], dialog: { ...f.dialog, readDelayMs: 150 } })
  const running = f.start(reader.sink)
  await until(() => f.fake.calls('read_owner_messages').length === 1)
  f.items([{ ...item, session: OTHER }])
  await until(() => !!running.view()?.polledAt)
  expect(running.view()?.blocked).toEqual({ session_unavailable: 1 })
  expect(reader.bodies()).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
})

test('a pinned legacy handoff adopts only an authenticated current assignment with the original thread and native SID', async () => {
  const message = ownerMessage(3, 'message')
  const f = fixture([message], [event(message, { executor: null, board_status: 'queued' })])
  const thread = handoff(false)
  const reader = protectedFixture()
  const pin = { taskId: 1, assignmentId: ASSIGNMENT, threadId: thread, sessionId: SID }
  const configure = (override: Partial<typeof pin> = {}) => {
    f.cfg.workdeskDialog = { legacyBindings: [{ ...pin, ...override }] }
  }
  const remote = { ...rawTask, executor: NAME, status: 'doing' }
  configure()
  expect((await f.tick(reader.sink))?.blocked).toEqual({ legacy_source_unavailable: 1 })
  f.fake.write({ tasks: [remote, remote], dialog: f.dialog })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ legacy_source_unavailable: 1 })
  f.fake.write({ tasks: [{ ...remote, assignment_id: STALE }], dialog: f.dialog })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ assignment_mismatch: 1 })
  f.fake.write({ tasks: [{ ...remote, executor: 'Different master' }], dialog: f.dialog })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ executor_changed: 1 })
  f.fake.write({ tasks: [remote], dialog: f.dialog })
  configure({ threadId: STALE })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ thread_reassigned: 1 })
  configure({ sessionId: OTHER })
  expect((await f.tick(reader.sink))?.blocked).toEqual({ session_unavailable: 1 })
  configure()
  f.items(null)
  expect((await f.tick(reader.sink))?.blocked).toEqual({ session_unavailable: 1 })
  expect(withDb(db => db.db.query('SELECT * FROM workdesk_dialog_bindings').all())).toEqual([])
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])

  f.items([item])
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  expect(withDb(db => db.db.query('SELECT thread_id, assignment_id, sid FROM workdesk_dialog_bindings').get())).toEqual(
    { thread_id: thread, assignment_id: ASSIGNMENT, sid: SID },
  )
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])

  const lists = f.fake.calls('list_board_tasks').length
  expect((await f.tick(reader.sink))?.pending).toBe(0)
  expect((await f.tick(reader.sink))?.pending).toBe(0)
  expect(f.fake.calls('list_board_tasks')).toHaveLength(lists)
  expect(f.fake.calls('claim_task')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toHaveLength(1)
  expect(reader.bodies()).toEqual([message])
  expect(rows().map(row => row.id)).toEqual([thread])
})

test('private app-server pipes enforce the bound SID and current thread across a restart after one remote ACK', async () => {
  const message = ownerMessage(8, 'choice')
  const f = fixture([message])
  const threadId = handoff()
  const key = randomBytes(32)
  const agent = { task_id: 1, assignment_id: ASSIGNMENT, thread_id: threadId, executor: NAME, sid: SID }
  const nativeItems = () => [item, { ...item, session: OTHER, key: OTHER, name: 'Another master' }]
  const make = (secret: Uint8Array) => createWorkdeskDialogSession(secret, nativeItems)
  const childFile = fileURLToPath(new URL('../support/fake-workdesk-session-client.ts', import.meta.url))
  function attach(mailbox: ReturnType<typeof make>, target: DialogTarget) {
    const child = spawn(process.execPath, [childFile], { stdio: ['pipe', 'pipe', 'ignore', 'ipc'] })
    const { stdout, stdin } = child
    if (!stdout || !stdin) throw new Error('missing private app-server pipes')
    const recipient = mailbox.attach(target)
    const serving = (async () => {
      try {
        for await (const line of createInterface({ input: stdout })) {
          const response = recipient.handleCodexRequest(JSON.parse(line))
          stdin.write(`${JSON.stringify(response)}\n`)
        }
      } finally {
        recipient.close()
      }
    })()
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await serving
    }
    onTestFinished(stop)
    let id = 0
    async function read(args: unknown = {}, reported = target.sid): Promise<unknown> {
      return await new Promise<unknown>((resolve, reject) => {
        child.once('message', raw => {
          const result = (raw as { result?: { success: boolean; contentItems: { text: string }[] } })?.result
          const content = result?.contentItems[0]?.text
          resolve(result?.success && content ? JSON.parse(content) : result?.success)
        })
        child.send(
          {
            id: ++id,
            method: 'item/tool/call',
            params: { tool: 'read_workdesk_dialog', threadId: reported, arguments: args },
          },
          error => {
            if (error) reject(error)
          },
        )
      })
    }
    return { stop, read }
  }

  const first = make(key)
  const owner = attach(first, agent)
  const other = attach(first, { ...agent, sid: OTHER })
  expect(await owner.read({}, OTHER)).toBe(false)
  expect(await other.read({ sid: SID, thread_id: threadId }, SID)).toBe(false)
  expect(await other.read({}, SID)).toBe(false)
  expect(await other.read()).toBe(false)

  f.fake.write({ tasks: [], dialog: { ...f.dialog, dropAck: 'after' } })
  expect((await f.tick(first.sink))?.blocked).toEqual({ ack: 1 })
  expect(f.fake.calls('ack_owner_messages')).toHaveLength(1)
  expect(await owner.read()).toEqual({ messages: [message], cursor: 8, more: false })
  expect(await other.read()).toBe(false)
  withDb(db => {
    const sealed = db.db.query<{ sealed: Uint8Array }, []>('SELECT sealed FROM workdesk_dialog_messages').get()
    if (!sealed) throw new Error('missing ciphertext')
    expect(Buffer.from(sealed.sealed).includes(privateText)).toBe(false)
    expect(JSON.stringify(entriesOf(db, threadId))).not.toContain(privateText)
  })
  await Promise.all([owner.stop(), other.stop()])
  expect(first.sink.permits(agent)).toBe(false)

  // A restarted process with the wrong key cannot validate its existing protected receipt.
  const wrongKey = make(randomBytes(32))
  const wrongSession = attach(wrongKey, agent)
  expect((await f.tick(wrongKey.sink))?.blocked).toEqual({ protected_delivery_failed: 1 })
  expect(await wrongSession.read()).toBe(false)
  expect(f.fake.calls('ack_owner_messages')).toHaveLength(1)
  await wrongSession.stop()

  const restarted = make(key)
  const same = attach(restarted, agent)
  const foreign = attach(restarted, { ...agent, sid: OTHER })
  expect((await f.tick(restarted.sink))?.pending).toBe(0)
  expect(f.fake.calls('ack_owner_messages')).toHaveLength(1)
  expect(await same.read()).toMatchObject({ messages: [message] })
  expect(await same.read({ after: 8 })).toMatchObject({ messages: [] })
  expect(await foreign.read()).toBe(false)

  withDb(db =>
    db.db
      .query('UPDATE threads SET assignee = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'session', key: OTHER, name: NAME }), threadId),
  )
  expect(await same.read()).toBe(false)
  expect(await foreign.read()).toBe(false)
  expect(rows().map(row => row.id)).toEqual([threadId])
  expect(f.fake.calls('ack_owner_messages')).toHaveLength(1)
}, 15_000)
