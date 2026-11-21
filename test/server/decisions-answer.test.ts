// The answer route's order of things (#487, server/routes/decisions.ts), against its handler with a
// stand-in send: a thread's question is answered in the thread before anything is typed in, so what
// the thread refuses types nothing; the answering mark is renewed while the send runs, so a default
// never goes beside an answer on its way; `seen` marks up to what the page showed, not to the
// server's time. State in a temp folder.
import { afterEach, expect, test } from 'bun:test'
import { readCard } from '../../src/adapters/cards.ts'
import { getDecision } from '../../src/adapters/decision-store.ts'
import { getEntry } from '../../src/adapters/schedule-store.ts'
import { entriesOf, getThread } from '../../src/adapters/work-thread-store.ts'
import type { AskSpec } from '../../src/core/decisions.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Item } from '../../src/core/types.ts'
import { type Party, threadsConfig } from '../../src/core/work-threads.ts'
import { decisionsRoutes } from '../../src/server/routes/decisions.ts'
import {
  askDecision,
  decisionsPayload,
  defaultDue,
  defaulted,
  seenAt,
  withDecisionsDb,
} from '../../src/services/decisions.ts'
import { askOwner, keepOpen, newThread, postEntry, type ThreadsCtx } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const ANNA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const BEN = 'bbbbbbbb-0000-4000-8000-00000000000b'
const spec = (over: Partial<AskSpec> = {}): AskSpec => ({
  question: 'Merge now or after the review?',
  options: ['Merge now', 'After review'],
  recommend: 1,
  defaultMs: 2 * 3_600_000,
  ...over,
})

afterEach(() => {
  delete process.env.BOARD_DECISION_ANSWERING_MS
})

/** The POST handler with `tell` standing in for the board's send. */
function route(tell: (key: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>) {
  const routes = decisionsRoutes({
    cfg: { decisions: true, threads: true },
    find: key => ({ key, session: key, name: key.slice(0, 4) }) as Item,
    tell,
    refresh: () => {},
  })
  const found = routes.find(r => r.method === 'POST')
  if (!found) throw new Error('no POST route')
  const post = found
  return async (body: Record<string, unknown>) => {
    const url = new URL('http://127.0.0.1/api/decisions')
    const res = (await post.handle(new Request(url, { method: 'POST' }), {
      url,
      path: url.pathname,
      rawPath: url.pathname,
      params: [],
      peer: () => '127.0.0.1',
      rawBody: async () => body,
    } as never)) as Response
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
}

const ask = (key = ANNA, s = spec(), now = Date.now()) =>
  withDecisionsDb(db => askDecision(db, { key, name: 'anna', lane: 'atlas', spec: s, ask: s.question, now }))
const row = (id: string) => withDecisionsDb(db => getDecision(db, id))

/** A thread of anna's that asks the owner, with its question's decision. */
function threadAsk(now = Date.now()) {
  const actor: Party = { kind: 'session', key: ANNA, name: 'anna' }
  const ctx = (db: Parameters<Parameters<typeof withDecisionsDb>[0]>[0], who: Party): ThreadsCtx => ({
    db,
    cfg: threadsConfig(true) as NonNullable<ReturnType<typeof threadsConfig>>,
    actor: who,
    now,
  })
  return withDecisionsDb(db => {
    const made = newThread(ctx(db, actor), { lane: 'atlas', title: 'Release' })
    const asked = askOwner(ctx(db, actor), made.head, 'Ship it?')
    const s = spec({ question: 'Ship it?', options: ['yes', 'no'], defaultMs: null, recommend: null })
    const d = askDecision(db, {
      key: ANNA,
      name: 'anna',
      lane: 'atlas',
      spec: s,
      ask: asked.head.waitingOn,
      thread: { id: made.head.id, key: made.head.key },
      now,
    })
    return { id: d.id, head: asked.head, ctx }
  })
}

test("a thread's question the thread refuses (a close proposed meanwhile): nothing typed, the question still open", async () => {
  isolatedHome()
  const t = threadAsk()
  // The agent says done meanwhile: a proposed close, the owner's to confirm or keep first.
  withDecisionsDb(db => {
    const head = getThread(db, t.head.id)
    if (head)
      postEntry(t.ctx(db, { kind: 'session', key: ANNA, name: 'anna' }), head, { status: 'done', summary: 'shipped' })
  })
  const told: string[] = []
  const post = route(async (_k, text) => {
    told.push(text)
    return { ok: true }
  })
  const res = await post({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(res.status).toBe(409)
  expect(String(res.body.error)).toContain('waits for Confirm or Keep open first')
  expect(told).toEqual([])
  expect(row(t.id)?.answeredAt).toBeNull()
  const cd = readCard(ANNA)?.decision as Record<string, unknown>
  expect(cd.id).toBe(t.id)
  expect(cd.answering).toBeUndefined()

  // Kept open: the answer goes in the thread first, then into the session.
  withDecisionsDb(db => {
    const head = getThread(db, t.head.id)
    if (head) keepOpen(t.ctx(db, { kind: 'owner' }), head)
  })
  const ok = await post({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(ok.status).toBe(200)
  expect(told).toEqual([`[board thread ${t.head.key}] yes`])
  expect(withDecisionsDb(db => entriesOf(db, t.head.id)).at(-1)).toMatchObject({ type: 'answer', text: 'yes' })
  expect(row(t.id)).toMatchObject({ answer: 'yes', answeredBy: 'owner', via: 'button' })
})

test("the answering mark is renewed while the send runs: the default waits past the mark's lifetime until it settles", async () => {
  isolatedHome()
  process.env.BOARD_DECISION_ANSWERING_MS = '300'
  const r = ask()
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  let release: () => void = () => {}
  const sending = new Promise<void>(resolve => {
    release = resolve
  })
  const post = route(async () => {
    await sending
    return { ok: true }
  })
  const answering = post({ op: 'answer', key: ANNA, id: r.id, option: 2 })
  // Three of the mark's lifetimes into a slow send (a wake): still held.
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(350)
    expect(defaultDue(entry, undefined, Date.now())).toBe('wait')
  }
  release()
  expect((await answering).status).toBe(200)
  expect(row(r.id)).toMatchObject({ answer: 'After review', answeredBy: 'owner', via: 'button' })
  expect(defaultDue(entry, undefined, Date.now())).toBe('drop')
})

test('a send that failed lets the default wait no more', async () => {
  isolatedHome()
  const r = ask()
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  const post = route(async () => ({ ok: false, error: 'the pane is gone' }))
  const res = await post({ op: 'answer', key: ANNA, id: r.id, option: 1 })
  expect(res.status).toBe(409)
  expect(defaultDue(entry, undefined, Date.now())).toBe('go')
  expect(row(r.id)?.answeredAt).toBeNull()
})

test('seen marks up to the newest default the page showed: one that went after its last board stays unseen', async () => {
  isolatedHome()
  const now = Date.now()
  const a = ask(ANNA, spec(), now - 10_000)
  const b = ask(BEN, spec({ question: 'Soon?' }), now - 10_000)
  const ea = getEntry(row(a.id)?.entry)
  const eb = getEntry(row(b.id)?.entry)
  if (!ea || !eb) throw new Error('no entry')
  defaulted(ea, now - 5000)
  // The page showed anna's; ben's goes before the click on the panel.
  defaulted(eb, now - 2000)
  const post = route(async () => ({ ok: true }))
  expect((await post({ op: 'seen', upTo: now - 5000 })).status).toBe(200)
  expect(seenAt()).toBe(now - 5000)
  const shown = decisionsPayload([], new Map(), { now, defaults: true })
  expect(shown.defaulted.map(d => d.question)).toEqual(['Soon?'])
  // Never back, never past the server's time.
  await post({ op: 'seen', upTo: now - 9000 })
  expect(seenAt()).toBe(now - 5000)
  await post({ op: 'seen', upTo: now + 3_600_000 })
  expect(seenAt()).toBeLessThanOrEqual(Date.now())
  expect(decisionsPayload([], new Map(), { now: Date.now(), defaults: true }).defaulted).toEqual([])
})
