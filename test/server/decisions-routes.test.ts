// The page's side of decisions (#487, server/routes/decisions.ts) against the web board, a fake herdr
// and (for a sleeper) a stand-in wake: a click types the option into the session through the board's
// send, waking a sleeping one, and closes the question as the owner's; Hold takes the default back;
// a question replaced between the page's read and the click is refused (#139); the payload carries
// the queue only while config.json turns decisions on.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDecision } from '../../src/adapters/decision-store.ts'
import type { AskSpec } from '../../src/core/decisions.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { threadsConfig } from '../../src/core/work-threads.ts'
import { askDecision, withDecisionsDb } from '../../src/services/decisions.ts'
import { askOwner, newThread, type ThreadsCtx } from '../../src/services/work-threads.ts'
import { serveBoard } from '../support/board-server.ts'
import { type FakeWake, fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  card,
  herdrAsleep,
  herdrAwake,
  projectDir,
  SCREEN,
  SID,
  SLEPT,
  scheduleDir,
  transcript,
  twoProfiles,
  wakeRuns,
} from '../support/sleeper-fixtures.ts'

setDefaultTimeout(40_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const spec = (over: Partial<AskSpec> = {}): AskSpec => ({
  question: 'Merge now or after the review?',
  options: ['Merge now', 'After review'],
  recommend: 1,
  defaultMs: 2 * 3_600_000,
  ...over,
})

/** `fn` with this process pointed at the sandbox's config and state folders. */
function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
const ask = (box: Sandbox, s = spec()) =>
  inBox(box, () =>
    withDecisionsDb(db => askDecision(db, { key: SID, name: 'Report', spec: s, ask: s.question, now: Date.now() })),
  )
const rowOf = (box: Sandbox, id: string) => inBox(box, () => withDecisionsDb(db => getDecision(db, id)))
const cardOf = (box: Sandbox): Record<string, unknown> =>
  JSON.parse(readFileSync(join(box.cards, `${SID}.json`), 'utf8')) as Record<string, unknown>
const prompts = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')

type Shown = { key: string; sleeping?: boolean; pane?: string | null; decision?: { id: string } }

/** The web board once it shows the session as `fits`; `post` and `board` as the page calls them. */
async function serve(box: Sandbox, cfg: Record<string, unknown>, fits: (i: Shown) => boolean) {
  const { url, proc } = await serveBoard(box, { language: 'en', wakeUrl: null, ...cfg }, boardOnPath(box))
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  const board = async (): Promise<Record<string, unknown> & { items?: Shown[] }> => {
    const before = refreshed()
    proc.send('refresh')
    await until(() => refreshed() > before)
    return (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown> & { items?: Shown[] }
  }
  for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
    const b = await board()
    if (!b.stale && b.items?.some(i => i.key === SID && fits(i))) break
    if (Date.now() > deadline) throw new Error(`the board did not show ${SID} as asked`)
  }
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${url}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  /** The payload once `fits` holds of it (the board refreshes on a card's change on its own time). */
  const boardWhen = async (fits: (b: Awaited<ReturnType<typeof board>>) => boolean) => {
    for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
      const b = await board()
      if (fits(b)) return b
      if (Date.now() > deadline) throw new Error(`the payload never fit: ${JSON.stringify(b.decisions)}`)
    }
  }
  return { post, board, boardWhen, url }
}

/** A session awake in p1, idle, on the Work profile. */
function awake(box: Sandbox) {
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  card(box, work)
  herdrAwake(box, cwd)
  return { list }
}

test("a click on an option types it into the session and closes the question as the owner's, by the button", async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const r = ask(box)
  const entry = rowOf(box, r.id)?.entry as string
  assert.ok(existsSync(join(scheduleDir(box), `${entry}.json`)))
  const { post } = await serve(box, { decisions: true, wake: false, profiles: list }, i => i.decision?.id === r.id)
  const res = await post({ op: 'answer', key: SID, id: r.id, option: 1 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p1', 'Merge now']])
  assert.equal(cardOf(box).ask, undefined)
  assert.equal(cardOf(box).decision, undefined)
  assert.equal(existsSync(join(scheduleDir(box), `${entry}.json`)), false)
  assert.deepEqual(
    (({ answer, answeredBy, via }) => ({ answer, answeredBy, via }))(rowOf(box, r.id) ?? ({} as never)),
    { answer: 'Merge now', answeredBy: 'owner', via: 'button' },
  )
  // Clicked again: no longer open.
  const again = await post({ op: 'answer', key: SID, id: r.id, option: 2 })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'This question is no longer open')
  assert.equal(prompts(box).length, 1)
})

test("a question replaced between the page's read and the click is refused, the new one untouched (#139)", async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const first = ask(box)
  const { post, boardWhen } = await serve(
    box,
    { decisions: true, wake: false, profiles: list },
    i => i.decision?.id === first.id,
  )
  const second = ask(box, spec({ question: 'Which branch?', options: ['main', 'dev'], defaultMs: null }))
  for (const body of [
    { op: 'answer', key: SID, id: first.id, option: 1 },
    { op: 'answer', key: SID, id: first.id, text: 'go' },
    { op: 'hold', key: SID, id: first.id },
  ]) {
    const res = await post(body)
    assert.equal(res.status, 409, JSON.stringify(body))
    assert.equal(res.body.error, 'This question is no longer open')
  }
  assert.deepEqual(prompts(box), [])
  assert.equal(cardOf(box).ask, 'Which branch?')
  assert.equal(rowOf(box, second.id)?.answeredAt, null)
  const queueOf = (b: Record<string, unknown>) =>
    (b.decisions as { items: { id: string | null }[] }).items.map(d => d.id)
  assert.deepEqual(queueOf(await boardWhen(b => queueOf(b)[0] === second.id)), [second.id])
})

test('Hold takes the default back and keeps the question; an own answer goes as typed', async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const r = ask(box)
  const entry = rowOf(box, r.id)?.entry as string
  const { post, boardWhen } = await serve(
    box,
    { decisions: true, wake: false, profiles: list },
    i => i.decision?.id === r.id,
  )
  const held = await post({ op: 'hold', key: SID, id: r.id })
  assert.equal(held.status, 200, JSON.stringify(held.body))
  assert.equal(existsSync(join(scheduleDir(box), `${entry}.json`)), false)
  assert.equal(cardOf(box).ask, 'Merge now or after the review?')
  const decisionOf = (b: { items?: Shown[] }) =>
    b.items?.find(i => i.key === SID)?.decision as Record<string, unknown> | undefined
  const shown = decisionOf(await boardWhen(b => typeof decisionOf(b)?.held === 'number')) as Record<string, unknown>
  assert.equal(typeof shown.held, 'number')
  assert.equal(shown.defaultAt, undefined)
  const own = await post({ op: 'answer', key: SID, id: r.id, text: 'neither, close the PR' })
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p1', 'neither, close the PR']])
  assert.equal(rowOf(box, r.id)?.via, 'text')
})

test('two answers at once (a button on the card, another in the panel or on the phone): one goes, the other is refused', async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const r = ask(box)
  const { post } = await serve(box, { decisions: true, wake: false, profiles: list }, i => i.decision?.id === r.id)
  const [a, b] = await Promise.all([
    post({ op: 'answer', key: SID, id: r.id, option: 1 }),
    post({ op: 'answer', key: SID, id: r.id, option: 2 }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]))
  assert.equal(prompts(box).length, 1)
  const refusedWith = String((a.status === 409 ? a : b).body.error)
  assert.ok(
    ['An answer to this question is on its way already', 'This question is no longer open'].includes(refusedWith),
    refusedWith,
  )
})

test('decisions off: no queue in the payload, no decision on the item, the route refused', async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const r = ask(box)
  const { post, board } = await serve(box, { wake: false, profiles: list }, () => true)
  const b = await board()
  assert.equal('decisions' in b, false)
  assert.equal(b.items?.find(i => i.key === SID)?.decision, undefined)
  const res = await post({ op: 'answer', key: SID, id: r.id, option: 1 })
  assert.equal(res.status, 409)
  assert.deepEqual(prompts(box), [])
})

/** A pane in workspace w1 as herdr's snapshot has it. */
function shell(cwd: string, session?: string) {
  return {
    pane_id: 'p1',
    workspace_id: 'w1',
    tab_id: 't1',
    cwd,
    ...(session && {
      agent: 'claude',
      agent_session: { value: session },
      agent_status: 'idle',
      terminal_title_stripped: 'Report',
    }),
  }
}

test('a sleeping session is woken by the answer, which goes in once', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  const r = ask(box)
  wakeRuns(box)
  const wake: FakeWake = await fakeWake({
    sleeping: [{ session: SID, name: 'Report', slept_at: new Date(SLEPT).toISOString(), pane: 'p1' }],
    wake: () => {
      box.state({
        'api snapshot': {
          result: {
            snapshot: {
              workspaces: [{ workspace_id: 'w1', label: 'w' }],
              tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
              panes: [shell(cwd, SID)],
            },
          },
        },
        'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
        'agent read': { text: SCREEN },
        'agent prompt': { result: {} },
      })
      wake.sleeping = []
      return { ok: true, pane: 'p1', name: 'Report' }
    },
  })
  const { post } = await serve(
    box,
    { decisions: true, wake: { enabled: true, port: wake.port }, profiles: list },
    i => i.sleeping === true && i.decision?.id === r.id,
  )
  const res = await post({ op: 'answer', key: SID, id: r.id, option: 2 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p1', 'After review']])
  assert.deepEqual(wake.requests().filter(q => q.method === 'POST' && q.path === '/wake').length, 1)
  assert.equal(rowOf(box, r.id)?.answeredBy, 'owner')
})

test("the Threads panel's answer to a thread's question with a decision: recorded with its words, as the owner's", async () => {
  const box = await sandbox()
  const { list } = awake(box)
  const t = inBox(box, () =>
    withDecisionsDb(db => {
      const ctx: ThreadsCtx = {
        db,
        cfg: threadsConfig(true) as NonNullable<ReturnType<typeof threadsConfig>>,
        actor: { kind: 'session', key: SID, name: 'Report' },
        now: Date.now(),
      }
      const made = newThread(ctx, { lane: 'atlas', title: 'Release' })
      const asked = askOwner(ctx, made.head, 'Ship it?')
      const s = spec({ question: 'Ship it?', options: ['yes', 'no'], recommend: null, defaultMs: null })
      const d = askDecision(db, {
        key: SID,
        name: 'Report',
        spec: s,
        ask: asked.head.waitingOn,
        thread: { id: made.head.id, key: made.head.key },
        now: Date.now(),
      })
      return { id: d.id, key: made.head.key }
    }),
  )
  const { url } = await serve(
    box,
    { decisions: true, threads: true, wake: false, profiles: list },
    i => i.decision?.id === t.id,
  )
  const res = await fetch(`${url}/api/threads/${t.key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'answer', text: 'Ship on Monday' }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  // The thread's own events may be typed in too (a board reminder from threads); the answer goes once.
  assert.deepEqual(
    prompts(box).filter(p => !String(p[3]).startsWith('[board reminder')),
    [['agent', 'prompt', 'p1', `[board thread ${t.key}] Ship on Monday`]],
  )
  await until(() => rowOf(box, t.id)?.answeredAt !== null)
  assert.deepEqual(
    (({ answer, answeredBy, via }) => ({ answer, answeredBy, via }))(rowOf(box, t.id) ?? ({} as never)),
    { answer: 'Ship on Monday', answeredBy: 'owner', via: 'text' },
  )
})
