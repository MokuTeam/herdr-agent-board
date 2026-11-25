// The answer route's order of things (#487, server/routes/decisions.ts), against its handler with a
// stand-in send: what the thread refuses types nothing, the thread gets the answer only once the
// session has it, a shared thread's answer goes to its peers (behind the passkey when it is on),
// and an old button on a thread that asks something else now is stale; the answering mark is renewed while the send runs, so a default
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

/** The POST handler with `tell` standing in for the board's send (and `over` for the rest of the board). */
function route(
  tell: (key: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  over: Partial<Parameters<typeof decisionsRoutes>[0]> = {},
) {
  const routes = decisionsRoutes({
    cfg: { decisions: true, threads: true },
    find: key => ({ key, session: key, name: key.slice(0, 4) }) as Item,
    tell,
    refresh: () => {},
    ...over,
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

/** A thread of anna's that asks the owner, with its question's decision (`shared`: with a peer, #394). */
function threadAsk(now = Date.now(), o: { defaultMs?: number | null; shared?: boolean } = {}) {
  const actor: Party = { kind: 'session', key: ANNA, name: 'anna' }
  const ctx = (db: Parameters<Parameters<typeof withDecisionsDb>[0]>[0], who: Party): ThreadsCtx => ({
    db,
    cfg: threadsConfig(true) as NonNullable<ReturnType<typeof threadsConfig>>,
    actor: who,
    now,
  })
  return withDecisionsDb(db => {
    const made = newThread(ctx(db, actor), { lane: 'atlas', title: 'Release' })
    if (o.shared)
      db.db.query('UPDATE threads SET scope = ? WHERE id = ?').run(
        JSON.stringify({
          kind: 'peer',
          peer: 'ben-peer',
          topic: `ben-peer/${made.head.id}`,
          key: made.head.key,
          by: 'me',
          at: now,
        }),
        made.head.id,
      )
    const head = getThread(db, made.head.id) ?? made.head
    const asked = askOwner(ctx(db, actor), head, 'Ship it?')
    const s = spec({
      question: 'Ship it?',
      options: ['yes', 'no'],
      defaultMs: o.defaultMs ?? null,
      recommend: o.defaultMs ? 1 : null,
    })
    const d = askDecision(db, {
      key: ANNA,
      name: 'anna',
      lane: 'atlas',
      spec: s,
      ask: asked.head.waitingOn,
      thread: { id: made.head.id, key: made.head.key, ask: asked.entry.id },
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

test("a node's session whose node is away (#784): the plain words, never the node proxy's code; another failure as it came", async () => {
  isolatedHome()
  const r = ask()
  const away = await route(async () => ({ ok: false, error: 'node-offline' }))({
    op: 'answer',
    key: ANNA,
    id: r.id,
    option: 1,
  })
  expect(away.status).toBe(409)
  expect(away.body.error).toBe('The device is not reachable')
  expect(away.body.error).not.toContain('node-offline')
  expect(row(r.id)?.answeredAt).toBeNull()
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

test("a thread's answer whose send failed: nothing written in the thread, the question and its default as they were", async () => {
  isolatedHome()
  const t = threadAsk(Date.now(), { defaultMs: 2 * 3_600_000 })
  const entry = getEntry(row(t.id)?.entry)
  if (!entry) throw new Error('no entry')
  let fail = true
  const told: string[] = []
  const post = route(async (_k, text) => {
    told.push(text)
    return fail ? { ok: false, error: 'the wake failed' } : { ok: true }
  })
  const res = await post({ op: 'answer', key: ANNA, id: t.id, option: 2 })
  expect(res.status).toBe(409)
  expect(res.body.error).toBe('the wake failed')
  const head = withDecisionsDb(db => getThread(db, t.head.id))
  expect(head?.status).toBe('owner')
  expect(withDecisionsDb(db => entriesOf(db, t.head.id)).some(e => e.type === 'answer')).toBe(false)
  expect((readCard(ANNA)?.decision as { id?: string } | undefined)?.id).toBe(t.id)
  expect(row(t.id)?.answeredAt).toBeNull()
  expect(defaultDue(entry, undefined, Date.now())).toBe('go')
  // The next click goes: the thread and the record get "no", the default goes away.
  fail = false
  const ok = await post({ op: 'answer', key: ANNA, id: t.id, option: 2 })
  expect(ok.status).toBe(200)
  expect(told).toEqual([`[board thread ${t.head.key}] no`, `[board thread ${t.head.key}] no`])
  expect(
    withDecisionsDb(db => entriesOf(db, t.head.id))
      .filter(e => e.type === 'answer')
      .map(e => e.text),
  ).toEqual(['no'])
  expect(row(t.id)).toMatchObject({ answer: 'no', answeredBy: 'owner' })
  expect(defaultDue(entry, undefined, Date.now())).toBe('drop')
})

test("a shared thread's answer written here goes to its peers, and the board's payload goes out again (#394)", async () => {
  isolatedHome()
  const t = threadAsk(Date.now(), { shared: true })
  const sent: [string, boolean][] = []
  let changed = 0
  const post = route(async () => ({ ok: true }), {
    changed: () => {
      changed++
    },
    work: {
      on: () => true,
      send: async (entry, unlocked) => {
        sent.push([entry, unlocked])
        return { state: 'sent' }
      },
    },
  })
  const res = await post({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(res.status).toBe(200)
  expect(res.body.shared).toBe('sent')
  const answer = withDecisionsDb(db => entriesOf(db, t.head.id)).find(e => e.type === 'answer')
  expect(answer?.out).toBe('queued')
  expect(sent).toEqual([[answer?.id ?? 'none', true]])
  expect(changed).toBeGreaterThanOrEqual(1)
})

test("with the passkey on, a shared thread's answer is typed in and recorded, and its going out waits for the confirmation (428)", async () => {
  isolatedHome()
  const t = threadAsk(Date.now(), { shared: true })
  const pended: unknown[] = []
  const told: string[] = []
  const post = route(
    async (_k, text) => {
      told.push(text)
      return { ok: true }
    },
    {
      work: { on: () => true, send: async (_entry, unlocked) => ({ state: unlocked ? 'sent' : 'confirm' }) },
      confirm: {
        required: () => true,
        unlocked: token => token === 'good',
        safe: () => true,
        away: () => false,
        pend: action => {
          pended.push(action)
          return 'AbCdEfGhIjKlMnOpQrStUv'
        },
        urlOf: id => `http://localhost:12422/?confirm=${id}`,
      },
    },
  )
  const res = await post({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(res.status).toBe(428)
  expect(res.body).toMatchObject({ ok: false, error: 'confirm', id: 'AbCdEfGhIjKlMnOpQrStUv' })
  expect(res.body.confirm).toBe('http://localhost:12422/?confirm=AbCdEfGhIjKlMnOpQrStUv')
  const answer = withDecisionsDb(db => entriesOf(db, t.head.id)).find(e => e.type === 'answer')
  expect(pended).toEqual([{ kind: 'thread-send', entry: answer?.id ?? 'none' }])
  expect(told).toEqual([`[board thread ${t.head.key}] yes`])
  expect(row(t.id)).toMatchObject({ answer: 'yes', answeredBy: 'owner' })
})

test("an old button on a thread that asks another session's question now: refused as stale, the card drops its buttons", async () => {
  isolatedHome()
  const t = threadAsk(Date.now(), { defaultMs: 2 * 3_600_000 })
  const entry = getEntry(row(t.id)?.entry)
  if (!entry) throw new Error('no entry')
  // ben asks on the same thread; anna's card still offers yes and no.
  withDecisionsDb(db => {
    const head = getThread(db, t.head.id)
    if (head) askOwner(t.ctx(db, { kind: 'session', key: BEN, name: 'ben' }), head, 'Which day?')
  })
  expect(defaultDue(entry, undefined, Date.now())).toBe('drop')
  const told: string[] = []
  const post = route(async (_k, text) => {
    told.push(text)
    return { ok: true }
  })
  const res = await post({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(res.status).toBe(409)
  expect(res.body.code).toBe('gone')
  expect(told).toEqual([])
  expect(withDecisionsDb(db => entriesOf(db, t.head.id)).some(e => e.type === 'answer')).toBe(false)
  expect(readCard(ANNA)?.decision).toBeUndefined()
  expect(row(t.id)).toMatchObject({ answeredBy: 'withdrawn', via: 'replaced' })
})

test("the thread's question asked again with no decision written (its write failed): an old button is stale there too", async () => {
  isolatedHome()
  const t = threadAsk()
  // anna asks again on the thread; the decision for it was never written, so her card keeps the old one.
  withDecisionsDb(db => {
    const head = getThread(db, t.head.id)
    if (head) askOwner(t.ctx(db, { kind: 'session', key: ANNA, name: 'anna' }), head, 'Which day?')
  })
  const told: string[] = []
  const res = await route(async (_k, text) => {
    told.push(text)
    return { ok: true }
  })({ op: 'answer', key: ANNA, id: t.id, option: 1 })
  expect(res.status).toBe(409)
  expect(told).toEqual([])
  expect(readCard(ANNA)?.decision).toBeUndefined()
})
