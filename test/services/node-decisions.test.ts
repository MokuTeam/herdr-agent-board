// Node sessions' decisions on the master (#781): a node session's `board ask` and `board thread ask`
// with options come up the uplink and the master holds them for the prefixed key (its copy of the
// card's ask and decision, the record, the default); the node's card carrying the decision is what
// keeps it open there; the answer goes to the node's session through the board's send for that key;
// the node's page relays `/api/decisions` with its own sessions' bare keys. And what a board without
// nodes does is as before. Cards, the schedule and the database in a temp state folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readCard } from '../../src/adapters/cards.ts'
import { getDecision } from '../../src/adapters/decision-store.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { getEntry, listEntries } from '../../src/adapters/schedule-store.ts'
import { type AskSpec, cardDecisionOf, heldByMaster, masterHeld } from '../../src/core/decisions.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { relayedDecisions, relayedSessionKey } from '../../src/core/master-relay.ts'
import { isRememberedCall, type UplinkResult, uplinkResultOf } from '../../src/core/node-uplink.ts'
import { type LinkStatus, nodeKey } from '../../src/core/nodes.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Item } from '../../src/core/types.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { decisionsRoutes } from '../../src/server/routes/decisions.ts'
import {
  askDecision,
  decisionsPayload,
  defaultDue,
  markAnswering,
  NODE_SETTLE_MS,
  nodeItemsDecisions,
  settleNodeDecisions,
  withDecisionsDb,
} from '../../src/services/decisions.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createUplinkRunner } from '../../src/services/nodes/uplink.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const KNOBS = { BOARD_TEST_PACE: '0.02' } as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const [k, v] of Object.entries(KNOBS)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterEach(() => {
  for (const k of Object.keys(KNOBS)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const NOW = Date.parse('2026-11-25T10:00:00Z')
const ANNA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const S1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d01'
const S2 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d02'
const S3 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d03'
const DEV = nodeKey('server-1', S1)
const spec = (over: Partial<AskSpec> = {}): AskSpec => ({
  question: 'Merge now or after the review?',
  options: ['Merge now', 'After review'],
  recommend: 1,
  defaultMs: 2 * 3_600_000,
  ...over,
})
/** The master's question for a node session, as its uplink asks it. */
const askFor = (key = DEV, now = NOW) =>
  withDecisionsDb(db =>
    askDecision(db, { key, name: 'worker', lane: 'atlas', spec: spec(), ask: spec().question, now, device: true }),
  )
const row = (id: string) => withDecisionsDb(db => getDecision(db, id))
/** A node's card as the master's aggregate has it: its decision as the node's card carries it. */
const nodeItem = (key: string, decision?: unknown): Item =>
  ({
    key,
    session: key,
    name: 'worker',
    attention: 'ask',
    question: 'q',
    ...(decision !== undefined && { decision }),
  }) as Item

/** A link that is online and serves what the test gives it. */
function standIn(serve: (path: string, init: RequestInit) => Promise<Response> | Response) {
  const state: LinkStatus = { state: 'online', since: 0, heardAt: null }
  const fns = new Set<(id: string) => void>()
  const link = {
    id: 'server-1',
    fetch: async (path: string, init?: RequestInit) => serve(path, init ?? {}),
    state: () => state,
  } as unknown as Link
  return {
    links: {
      link: (id: string) => (id === 'server-1' ? link : null),
      onChange(fn: (id: string) => void) {
        fns.add(fn)
        return () => fns.delete(fn)
      },
    },
    online() {
      for (const fn of fns) fn('server-1')
    },
  }
}

/** A stream of these calls, held open until the link aborts it. */
function streamOf(calls: unknown[], signal?: AbortSignal | null): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const call of calls) c.enqueue(enc.encode(`event: call\ndata: ${JSON.stringify(call)}\n\n`))
      signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true })
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** The master's runner with these node calls on its first stream; the results it posted, by call id. */
async function master(cfg: Record<string, unknown>, sent: unknown[], want: number) {
  const dir = isolatedHome()
  const posted: { id: string; body: UplinkResult }[] = []
  let streams = 0
  const link = standIn((path, init) => {
    if (path === '/api/node/uplink') return streamOf(streams++ ? [] : sent, init.signal)
    posted.push({ id: path.split('/').pop() as string, body: JSON.parse(String(init.body)) })
    return new Response('{}')
  })
  const cards = [S1, S2, S3].map(s => ({ key: nodeKey('server-1', s), category: 'atlas', name: 'worker' }) as Item)
  // The thread the node's sessions ask in, made on the master as the owner's.
  if (cfg.threads)
    await threadCmd(['new', '--lane', 'atlas', 'Release'], {
      cfg: { threads: true, port: 1 },
      actor: { kind: 'owner' },
      lane: 'atlas',
      findSession: async () => null,
      out: () => {},
      err: () => {},
    })
  const runner = createUplinkRunner({
    links: link.links,
    find: key => cards.find(c => c.key === key),
    items: () => cards,
    cfg: { port: 1, ...cfg } as never,
    log: () => {},
    store: createDeviceStore({ dir: join(dir, 'nodes') }),
  })
  link.online()
  await until(() => posted.length >= want, 10_000)
  await runner.close()
  return (id: string) => posted.filter(p => p.id === id).map(p => p.body)
}

describe("the master holds a node session's question with options", () => {
  test('board ask: its copy of the card, the record and the default under the prefixed key; the node gets the decision; sent again, it is the same one', async () => {
    const ask = {
      id: 'a-1',
      cmd: 'ask',
      argv: [
        '--option',
        'Merge now',
        '--option',
        'After review',
        '--recommend',
        '1',
        '--default-after',
        '2h',
        '--',
        'Merge now?',
      ],
      session: S1,
      lane: 'elsewhere',
      files: [],
    }
    const results = await master({ decisions: true }, [ask, ask], 2)
    const [first, again] = results('a-1')
    const card = readCard(DEV)
    const held = cardDecisionOf(card?.decision)
    expect(held?.options).toEqual(['Merge now', 'After review'])
    expect(card?.ask).toBe('Merge now?')
    expect(first?.code).toBe(0)
    expect(first?.out).toEqual([` · decision ${held?.id} · default in 2 h`])
    expect(first?.decision).toEqual(held ?? undefined)
    // Remembered by its call id: the second time is the first's result, not a second question.
    expect(again).toEqual(first)
    const r = row(held?.id as string)
    expect(r?.session).toBe(DEV)
    expect(r?.lane).toBe('atlas')
    expect(listEntries().map(e => [e.key, e.decision])).toEqual([[DEV, held?.id]])
    expect(isRememberedCall('ask', [])).toBe(true)
  })

  test("board thread ask: with options the master holds it with its thread; a plain one stays the node card's alone", async () => {
    const withOptions = {
      id: 't-1',
      cmd: 'thread',
      argv: ['ask', 'atlas-1', 'Ship it?', '--option', 'yes', '--option', 'no', '--recommend', '1'],
      session: S2,
      lane: null,
      files: [],
    }
    const plain = {
      id: 't-2',
      cmd: 'thread',
      argv: ['ask', 'atlas-1', 'Anything else?'],
      session: S3,
      lane: null,
      files: [],
    }
    const results = await master({ decisions: true, threads: true }, [withOptions, plain], 2)
    const [asked] = results('t-1')
    const card = readCard(nodeKey('server-1', S2))
    const held = cardDecisionOf(card?.decision)
    expect(asked?.code).toBe(0)
    expect(asked?.decision).toEqual(held ?? undefined)
    expect(held?.options).toEqual(['yes', 'no'])
    expect(held?.thread?.key).toBe('atlas-1')
    expect(asked?.out.at(-1)).toBe(`ok · atlas-1 · owner · decision ${held?.id}`)
    expect(row(held?.id as string)?.session).toBe(nodeKey('server-1', S2))
    const [other] = results('t-2')
    expect(other?.code).toBe(0)
    expect(other && 'decision' in other).toBe(false)
    expect(readCard(nodeKey('server-1', S3))).toBeNull()
  })

  test('decisions off on the master: refused in words, nothing written', async () => {
    const ask = {
      id: 'a-2',
      cmd: 'ask',
      argv: ['--option', 'a', '--option', 'b', '--', 'Which?'],
      session: S1,
      lane: null,
      files: [],
    }
    const [r] = (await master({}, [ask], 1))('a-2')
    expect(r?.code).toBe(1)
    expect(r?.err.join(' ')).toContain('decisions are off')
    expect(readCard(DEV)).toBeNull()
    expect(listEntries()).toEqual([])
  })
})

describe('the node card is what keeps it open', () => {
  test("the default goes while the node's card carries the decision, waits just after the ask, and drops once it does not", () => {
    isolatedHome()
    const r = askFor()
    const entry = getEntry(row(r.id)?.entry as string) as ScheduleEntry
    const due = r.defaultAt as number
    const cfg = { decisions: true }
    expect(defaultDue(entry, cfg, due, { item: () => nodeItem(DEV, { id: r.id, options: ['a', 'b'] }) })).toBe('go')
    // Not seen (the node away): the scheduler's own node delivery holds it.
    expect(defaultDue(entry, cfg, due, { item: () => undefined })).toBe('go')
    // Just asked, its card not shown yet with it: waits.
    expect(defaultDue(entry, cfg, NOW + 1000, { item: () => nodeItem(DEV) })).toBe('wait')
    // Its card no longer carries it (answered at the node, board doing, another question): dropped.
    expect(defaultDue(entry, cfg, due, { item: () => nodeItem(DEV) })).toBe('drop')
    expect(defaultDue(entry, cfg, due, { item: () => nodeItem(DEV, { id: 'other', options: ['a', 'b'] }) })).toBe(
      'drop',
    )
    // Without the nodes' cards (a board without nodes), as before: not this board's.
    expect(defaultDue(entry, cfg, due)).toBe('drop')
  })

  test("withdrawn here once the node's card drops it; kept while it carries it, while just asked, and while not seen", () => {
    isolatedHome()
    const r = askFor()
    const items = (decision?: unknown) => [nodeItem(DEV, decision)]
    const settle = (list: Item[], now: number) =>
      withDecisionsDb(db => settleNodeDecisions(db, list, new Map([[DEV, readCard(DEV) as never]]), now))
    settle(items({ id: r.id, options: ['a', 'b'] }), NOW + NODE_SETTLE_MS * 2)
    settle(items(), NOW + 1000)
    settle([], NOW + NODE_SETTLE_MS * 2)
    expect(row(r.id)?.answeredAt).toBeNull()
    expect(cardDecisionOf(readCard(DEV)?.decision)?.id).toBe(r.id)
    settle(items(), NOW + NODE_SETTLE_MS * 2)
    expect(row(r.id)?.answeredBy).toBe('withdrawn')
    expect(readCard(DEV)?.ask).toBeUndefined()
    expect(readCard(DEV)?.decision).toBeUndefined()
    expect(listEntries()).toEqual([])
  })

  test("the owner's answer typed at the node (#784): recorded as the owner's; a note of another question is not", () => {
    isolatedHome()
    const settle = (item: Item) =>
      withDecisionsDb(db =>
        settleNodeDecisions(db, [item], new Map([[DEV, readCard(DEV) as never]]), NOW + NODE_SETTLE_MS * 2),
      )
    const r = askFor()
    settle({ ...nodeItem(DEV), decisionAnswer: { id: r.id, answer: 'After review', at: NOW + 5000 } })
    expect(row(r.id)).toMatchObject({ answer: 'After review', answeredBy: 'owner', via: 'prompt' })
    expect(readCard(DEV)?.ask).toBeUndefined()
    expect(readCard(DEV)?.decision).toBeUndefined()
    expect(listEntries()).toEqual([])
    // The card still notes the answer to the one before: this one is withdrawn, as without a note.
    const next = askFor()
    settle({ ...nodeItem(DEV), decisionAnswer: { id: r.id, answer: 'After review', at: NOW + 5000 } })
    expect(row(next.id)).toMatchObject({ answer: null, answeredBy: 'withdrawn', via: 'cleared' })
  })

  test("left alone while this board types the page's answer in (#784): the answer's route closes it", () => {
    isolatedHome()
    const r = askFor()
    const now = NOW + NODE_SETTLE_MS * 2
    expect(markAnswering(DEV, r.id, 'button', now)).toBe(true)
    withDecisionsDb(db => settleNodeDecisions(db, [nodeItem(DEV)], new Map([[DEV, readCard(DEV) as never]]), now))
    expect(row(r.id)?.answeredAt).toBeNull()
    expect(cardDecisionOf(readCard(DEV)?.decision)?.id).toBe(r.id)
  })

  test("the master's page shows its own copy on the node's card, none once closed or while off; the queue has it", () => {
    isolatedHome()
    const r = askFor()
    const cards = () => new Map([[DEV, readCard(DEV) as never]])
    const carried = { id: r.id, options: ['Merge now', 'After review'] }
    const [shown] = nodeItemsDecisions([nodeItem(DEV, carried)], cards(), true)
    expect(shown?.decision).toEqual(cardDecisionOf(readCard(DEV)?.decision) ?? undefined)
    expect(shown?.decision?.defaultAt).toBe(r.defaultAt as number)
    const [off] = nodeItemsDecisions([nodeItem(DEV, carried)], cards(), false)
    expect(off && 'decision' in off).toBe(false)
    const [stale] = nodeItemsDecisions([nodeItem(DEV, { id: 'old', options: ['a', 'b'] })], cards(), true)
    expect(stale && 'decision' in stale).toBe(false)
    // The Decisions queue: the node's question with its options; a node card's plain ask is not this board's.
    const plainKey = nodeKey('server-1', S2)
    const q = decisionsPayload([nodeItem(DEV, carried), nodeItem(plainKey)], cards(), {
      now: NOW + 1000,
      defaults: true,
      seen: 0,
    })
    expect(q.items.map(i => [i.key, i.id, i.options])).toEqual([[DEV, r.id, ['Merge now', 'After review']]])
  })

  test('a node card keeps the mark that its master holds it; the mark is no part of what is shown', () => {
    const d = masterHeld({ id: 'd1', options: ['a', 'b'] })
    expect(heldByMaster(d)).toBe(true)
    expect(heldByMaster({ id: 'd1', options: ['a', 'b'] })).toBe(false)
    expect(cardDecisionOf(d)).toEqual({ id: 'd1', options: ['a', 'b'] })
  })
})

describe('the answer', () => {
  test("a click on the master's page types into the node's session by its prefixed key and closes the question there", async () => {
    isolatedHome()
    const r = askFor(DEV, Date.now())
    const told: [string, string][] = []
    const routes = decisionsRoutes({
      cfg: { decisions: true, threads: true },
      find: key => (key === DEV ? nodeItem(DEV) : undefined),
      tell: async (key, text) => {
        told.push([key, text])
        return { ok: true }
      },
      refresh: () => {},
    })
    const post = routes.find(x => x.method === 'POST')
    const url = new URL('http://127.0.0.1/api/decisions')
    const res = (await post?.handle(new Request(url, { method: 'POST' }), {
      url,
      path: url.pathname,
      rawPath: url.pathname,
      params: [],
      peer: () => '127.0.0.1',
      rawBody: async () => ({ op: 'answer', key: DEV, id: r.id, option: 2 }),
    } as never)) as Response
    expect(res.status).toBe(200)
    expect(told).toEqual([[DEV, 'After review']])
    expect(row(r.id)?.answeredBy).toBe('owner')
    expect(row(r.id)?.answer).toBe('After review')
    expect(readCard(DEV)?.ask).toBeUndefined()
    expect(listEntries()).toEqual([])
  })
})

describe("the wire and the node's page", () => {
  test('a result keeps a decision that reads as one and drops one that does not; without one it is as before', () => {
    const base = { code: 0, out: ['ok'], err: [] }
    expect(uplinkResultOf(base)).toEqual(base)
    const decision = { id: 'd1', options: ['a', 'b'], recommend: 1, defaultAt: 5 }
    expect(uplinkResultOf({ ...base, decision })).toEqual({ ...base, decision })
    for (const bad of [
      { id: 'd1', options: [] },
      { id: '', options: ['a'] },
      'd1',
      { id: 'd1', options: ['x'.repeat(501)] },
    ])
      expect(uplinkResultOf({ ...base, decision: bad })).toEqual(base)
  })

  test("the node's page names its own sessions by bare keys: the master reads them as that device's; another machine's key stays", () => {
    expect(relayedSessionKey(ANNA, 'server-1')).toBe(nodeKey('server-1', ANNA))
    expect(relayedSessionKey('pane-w1:p2', 'server-1')).toBe(nodeKey('server-1', 'pane-w1:p2'))
    expect(relayedSessionKey(nodeKey('studio', ANNA), 'server-1')).toBe(nodeKey('studio', ANNA))
    expect(relayedSessionKey('', 'server-1')).toBeNull()
    const url = new URL('http://master/api/decisions')
    const post = relayedDecisions('POST', url, { op: 'answer', key: ANNA, id: 'd1', option: 1 }, 'server-1')
    expect(post?.body).toEqual({ op: 'answer', key: nodeKey('server-1', ANNA), id: 'd1', option: 1 })
    // 'seen' names no session: as it came.
    expect(relayedDecisions('POST', url, { op: 'seen', upTo: 5 }, 'server-1')?.body).toEqual({ op: 'seen', upTo: 5 })
    const get = relayedDecisions('GET', new URL(`http://master/api/decisions?session=${ANNA}`), undefined, 'server-1')
    expect(get?.url.searchParams.get('session')).toBe(nodeKey('server-1', ANNA))
    expect(relayedDecisions('GET', url, undefined, 'server-1')?.url).toBe(url)
    expect(relayedDecisions('POST', url, { op: 'answer', key: 'a\u0000b', id: 'd1' }, 'server-1')).toBeNull()
  })
})

describe('a board without nodes is as before', () => {
  test("its own session's default, queue and cards: no node card in view, nothing of this runs", () => {
    isolatedHome()
    const r = withDecisionsDb(db =>
      askDecision(db, { key: ANNA, name: 'anna', lane: 'atlas', spec: spec(), ask: spec().question, now: NOW }),
    )
    const entry = getEntry(row(r.id)?.entry as string) as ScheduleEntry
    expect(defaultDue(entry, { decisions: true }, r.defaultAt as number)).toBe('go')
    const own = { key: ANNA, session: ANNA, name: 'anna', attention: 'ask' } as Item
    const q = decisionsPayload([own], new Map([[ANNA, readCard(ANNA) as never]]), {
      now: NOW + 1000,
      defaults: true,
      seen: 0,
    })
    expect(q.items.map(i => i.id)).toEqual([r.id])
    expect(q.items[0]?.options).toEqual(['Merge now', 'After review'])
    // Its prefixed twin's card is never read for it: settling node decisions leaves it open.
    withDecisionsDb(db =>
      settleNodeDecisions(db, [own], new Map([[ANNA, readCard(ANNA) as never]]), NOW + NODE_SETTLE_MS * 2),
    )
    expect(row(r.id)?.answeredAt).toBeNull()
  })
})
