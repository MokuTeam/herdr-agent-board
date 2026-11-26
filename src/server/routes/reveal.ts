// A session to show (entrypoints/web-open.ts, when a notification is clicked): pages open its sheet,
// those connected now and those that connect within REVEAL_MS (a window being raised).
// { ok, key, pages } or 404 when the board has no session in that pane. `{ thread }` instead (#392,
// `board thread open`, web-open.ts --thread) goes to `thread` (routes/threads.ts threadReveal).
// On a node whose page went to its master (#841), what it shows goes up to the master's pages too
// (`up`, POST /api/node-reveal through the relay): the board's window shows the master's page there.

import { t } from '../../core/lang.ts'
import { type NodeReveal, nodeRevealOf } from '../../core/master-relay.ts'
import { nodeKey } from '../../core/nodes.ts'
import type { BoardState } from '../board-state.ts'
import { json, type Route } from '../http.ts'
import { type Broadcaster, namedEvent } from '../sse.ts'

export const REVEAL_MS = 15_000

export interface RevealState {
  /** A notification click asked for this session. */
  asked(key: string): void
  /**
   * What a page that connects now is told besides the board: the session asked for within
   * REVEAL_MS, once. A page in a minimized or covered window keeps no stream, and connects again
   * only once its window is raised; one that comes back later on its own is not sent there.
   */
  greet(): string
}

export function revealState(now: () => number = Date.now): RevealState {
  let revealing: { key: string; at: number } | null = null
  return {
    asked(key) {
      revealing = { key, at: now() }
    },
    greet() {
      const r = revealing
      revealing = null
      return r && now() - r.at < REVEAL_MS ? namedEvent('reveal', { key: r.key }) : ''
    },
  }
}

/**
 * Sends a reveal up to the node's master (#841): its answer, or null when this board does not
 * (no node, its page stays here, the master not reachable).
 */
export type RevealUp = (what: NodeReveal) => Promise<Response | null>

export function revealRoute(
  board: Pick<BoardState, 'find' | 'items'>,
  events: Pick<Broadcaster, 'event' | 'size'>,
  state: Pick<RevealState, 'asked'>,
  thread?: (word: unknown) => Response,
  up?: RevealUp,
): Route {
  return {
    method: 'POST',
    path: '/api/reveal',
    guard: ['board-header'],
    async handle(_req, ctx) {
      const body = await ctx.body()
      if (thread && body.thread !== undefined && body.key === undefined && body.pane === undefined)
        return up ? threadUp(body.thread, thread, events, up) : thread(body.thread)
      const item = body.key
        ? board.find(String(body.key))
        : body.pane
          ? board.items().find(i => i.pane === String(body.pane))
          : undefined
      if (!item) return json(404, { ok: false, error: t('err.gone') })
      state.asked(item.key)
      events.event('reveal', { key: item.key })
      // The master's pages hear it as they can; this answer does not wait for them.
      if (up) void up({ key: item.key }).catch(() => null)
      return json(200, { ok: true, key: item.key, pages: events.size() })
    },
  }
}

/**
 * A thread to show on a node (#841): the threads are its master's, so the master's pages are told
 * and its answer comes back; on ok the node's pages open now are told too (a local tab, ?local=1).
 * The master's "no such thread" (400, 404) is the answer; no answer, or any other, goes to this
 * board's own `thread` as before.
 */
export async function threadUp(
  word: unknown,
  thread: (word: unknown) => Response,
  events: Pick<Broadcaster, 'event'>,
  up: RevealUp,
): Promise<Response> {
  const key = String(word ?? '')
    .trim()
    .toLowerCase()
  const res = key ? await up({ thread: key }).catch(() => null) : null
  if (res && (res.status === 400 || res.status === 404)) return res
  if (!res?.ok) return thread(word)
  events.event('thread-open', { key })
  return res
}

/** What the master does with a node's reveal (#841, server/app.ts replayRelayed). */
export interface NodeRevealDeps {
  /** A session of this board or of a node of its (BoardState.findAny). */
  findAny(key: string): { key: string } | undefined
  events: Pick<Broadcaster, 'event' | 'size'>
  state: Pick<RevealState, 'asked'>
  /** A thread shown on this board's pages (routes/threads.ts threadReveal). */
  thread(word: unknown): Response
}

/**
 * POST /api/node-reveal from node `device` (#841): its own session, by the key the node knows it
 * by, shown on this board's pages as `@<device>:<key>`, as a notification clicked here shows one of
 * this board's own; or a thread. 404 for a session this board does not have from that node.
 */
export function nodeRevealAnswer(raw: unknown, device: string, deps: NodeRevealDeps): Response {
  const what = nodeRevealOf(raw)
  if (!what) return json(400, { ok: false, error: 'reveal' })
  if ('thread' in what) return deps.thread(what.thread)
  let key: string
  try {
    key = nodeKey(device, what.key)
  } catch {
    return json(400, { ok: false, error: 'reveal' })
  }
  const item = deps.findAny(key)
  if (!item) return json(404, { ok: false, error: t('err.gone') })
  deps.state.asked(item.key)
  deps.events.event('reveal', { key: item.key })
  return json(200, { ok: true, key: item.key, pages: deps.events.size() })
}
