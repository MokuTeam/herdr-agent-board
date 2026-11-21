// Decisions (#487, services/decisions.ts): POST { op: 'answer', key, id, option?: n | text } types the
// option's label (or the owner's own words) into the session through the board's send, waking it
// when it sleeps, and closes the question as the owner's; { op: 'hold', key, id } takes its default
// back and keeps the question; { op: 'seen', upTo } marks what went by default up to the newest the
// page showed as seen (the panel was opened). A question no longer open (answered, replaced by another ask, withdrawn) is refused, so a
// click on a page that read it before never answers the next one (#139). GET ?session=<key>: that
// session's closed ones, for its sheet. The phone takes the same routes. While decisions are off
// every call is refused and nothing is read.
import { isRecord } from '../../adapters/json-store.ts'
import { threadByKey } from '../../adapters/work-thread-store.ts'
import { DecisionError, decisionsConfig } from '../../core/decisions.ts'
import { t } from '../../core/lang.ts'
import type { Config, Item } from '../../core/types.ts'
import { cleanText, threadsConfig } from '../../core/work-threads.ts'
import {
  answeringMs,
  closeCardDecision,
  decisionsDone,
  holdOpen,
  markAnswering,
  markSeen,
  openOf,
  seenAt,
  withDecisionsDb,
} from '../../services/decisions.ts'
import { answerAsk, answerCheck, withThreadsDb } from '../../services/work-threads.ts'
import { json, type Route } from '../http.ts'

export interface DecisionsApp {
  cfg: Pick<Config, 'decisions' | 'threads'>
  find(key: string): Item | undefined
  /** Types `text` into the session (the board's send, waking it). */
  tell(key: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>
  refresh(): void
  /** The board's payload goes out again (a thread's answer moved its revision), as the Threads routes' changed(). */
  changed?(): void
  /**
   * A shared thread's entry (#394) written here goes to its peers, as the Threads panel's answer
   * does (or waits for the owner's passkey); its state.
   */
  share?(entry: string, req: Request): Promise<string>
  now?: () => number
  log?: (line: string) => void
}

const ANSWER_MAX = 2000

const refused = (err: unknown): Response =>
  err instanceof DecisionError
    ? json(err.code === 'gone' ? 409 : 400, {
        ok: false,
        error: t(`dec.err.${err.code === 'gone' ? 'gone' : 'bad'}`),
        code: err.code,
      })
    : json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })

export function decisionsRoutes(app: DecisionsApp): Route[] {
  const now = () => app.now?.() ?? Date.now()
  const on = () => decisionsConfig(app.cfg.decisions)

  async function answer(key: string, id: string, body: Record<string, unknown>, req: Request): Promise<Response> {
    const item = app.find(key)
    if (!item) return json(404, { ok: false, error: t('err.gone') })
    let open: ReturnType<typeof openOf>
    try {
      open = withDecisionsDb(db => openOf(db, key, id))
    } catch (err) {
      return refused(err)
    }
    const { decision } = open
    const n = typeof body.option === 'number' ? body.option : null
    const label = n !== null ? decision.options[n - 1] : undefined
    if (n !== null && label === undefined) return json(400, { ok: false, error: t('dec.err.bad') })
    const text = label ?? cleanText(body.text, ANSWER_MAX)
    if (!text) return json(400, { ok: false, error: t('dec.err.empty') })
    const via = label !== undefined ? 'button' : 'text'
    // The hook that sees it typed in records it as given here; the default waits meanwhile. One
    // answer at a time: a second click (another button, the phone) while the first goes is refused.
    if (!markAnswering(key, id, via, now())) return json(409, { ok: false, error: t('dec.err.busy'), code: 'busy' })
    const thread = decision.thread
    // A thread's question: what the thread refuses (a close the agent proposed, words too long,
    // nothing asked) is refused before anything is typed in; the answer is written in the thread
    // only once the session has it, so a send that failed leaves the thread as it was.
    const threads = thread ? threadsConfig(app.cfg.threads) : null
    if (thread && threads) {
      try {
        withThreadsDb(false, db => {
          const head = db && threadByKey(db, thread.key)
          if (db && head) answerCheck(db, head, text)
        })
      } catch (err) {
        markAnswering(key, id, null, now())
        return json(409, { ok: false, error: err instanceof Error ? err.message : String(err), code: 'thread' })
      }
    }
    // The mark is renewed while the send runs (a sleeping session's wake takes a while), so the
    // default never goes beside an answer still on its way.
    const renew = setInterval(() => {
      try {
        markAnswering(key, id, via, now(), { renew: true })
      } catch {}
    }, answeringMs() / 3)
    const told = await app
      .tell(key, thread ? `[board thread ${thread.key}] ${text}` : text)
      .catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => clearInterval(renew))
    if (!told.ok) {
      markAnswering(key, id, null, now())
      return json(409, { ok: false, error: told.error })
    }
    let shared: string | undefined
    if (thread && threads) {
      try {
        const written = withThreadsDb(false, db => {
          const head = db && threadByKey(db, thread.key)
          return db && head ? answerAsk({ db, cfg: threads, actor: { kind: 'owner' }, now: now() }, head, text) : null
        })
        if (written) {
          app.changed?.()
          // A shared thread's answer goes to its peers, as the Threads panel's does.
          if (written.entry.out === 'queued' && app.share) shared = await app.share(written.entry.id, req)
        }
      } catch (err) {
        // The session has the answer; the thread changed in between (answered elsewhere): the log says so.
        app.log?.(`decision ${id}: thread ${thread.key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    withDecisionsDb(db =>
      closeCardDecision(db, key, { answer: text, answeredBy: 'owner', via, at: now() }, { id, ask: true, by: 'owner' }),
    )
    app.refresh()
    return json(200, { ok: true, ...(shared && { shared }) })
  }

  return [
    {
      method: 'POST',
      path: '/api/decisions',
      // An answer types into a session, as a message does: only through a herdr the board reaches.
      guard: ['board-header', 'fresh-data'],
      async handle(req, ctx) {
        if (!on()) return json(409, { ok: false, error: t('dec.err.off') })
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (body.op === 'seen') {
          // Up to what the page showed (the newest default's time on it): one that went after the
          // page's last board stays unseen. A page that sends none marks up to now.
          const upTo = typeof body.upTo === 'number' && Number.isFinite(body.upTo) ? Math.min(body.upTo, now()) : now()
          if (upTo > seenAt()) markSeen(upTo)
          app.refresh()
          return json(200, { ok: true })
        }
        const key = typeof body.key === 'string' ? body.key : ''
        const id = typeof body.id === 'string' ? body.id : ''
        if (!key || !id) return json(400, { ok: false, error: t('dec.err.bad') })
        if (body.op === 'answer') return answer(key, id, body, req)
        if (body.op === 'hold') {
          try {
            withDecisionsDb(db => holdOpen(db, key, id, now()))
          } catch (err) {
            return refused(err)
          }
          app.refresh()
          return json(200, { ok: true })
        }
        return json(400, { ok: false, error: t('dec.err.bad') })
      },
    },
    {
      method: 'GET',
      path: '/api/decisions',
      guard: ['board-header'],
      async handle(_req, ctx) {
        if (!on()) return json(409, { ok: false, error: t('dec.err.off') })
        const session = ctx.url.searchParams.get('session') ?? undefined
        const done = decisionsDone({ ...(session && { session }), limit: 20 }).map(r => ({
          id: r.id,
          question: r.question,
          options: r.options,
          recommend: r.recommend,
          answer: r.answer,
          answeredBy: r.answeredBy,
          via: r.via,
          askedAt: r.askedAt,
          answeredAt: r.answeredAt,
        }))
        return json(200, { ok: true, done })
      },
    },
  ]
}
