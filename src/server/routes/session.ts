// One session: its detail and changes, its history, and the actions on it (services/actions.ts,
// services/answer.ts, its card). A session that is gone is a 404 whatever is asked of it, before
// any guard; what else no route here answers goes on to the page's files and the 405 (main's chain).
import { randomUUID } from 'node:crypto'
import { type CardPatch, writeCard } from '../../adapters/cards.ts'
import { checkoutChanges, isCheckout } from '../../adapters/git.ts'
import { helpersOf } from '../../adapters/helpers.ts'
import { herdrText } from '../../adapters/herdr.ts'
import { uploadsDir } from '../../adapters/paths.ts'
import { askRestart } from '../../adapters/schedule-store.ts'
import { busy, PINS } from '../../core/board.ts'
import { type PublicDialog, parseDialog, publicDialog } from '../../core/dialogs/questions.ts'
import { publicHelper } from '../../core/helpers.ts'
import { t } from '../../core/lang.ts'
import { checkName } from '../../core/launch/names.ts'
import type { MessageGate } from '../../core/message-gate.ts'
import { isPiItem } from '../../core/pi.ts'
import type { Item, Pin } from '../../core/types.ts'
import { checkWake, focus, send, sleepSession, wake, wakeAnswers } from '../../services/actions.ts'
import { answerPermission, answerQuestions } from '../../services/answer.ts'
import { askArchive, undoMs } from '../../services/archive.ts'
import { askAside } from '../../services/aside.ts'
import { collect } from '../../services/board.ts'
import type { Deps } from '../../services/deps.ts'
import { forkSession } from '../../services/launch/fork.ts'
import type { Launches } from '../../services/launch/launches.ts'
import { renameSession, renameWorkspace } from '../../services/launch/rename.ts'
import { startCall } from '../../services/mokupilot.ts'
import { type Body, type Handler, json, type Route } from '../http.ts'
import { helperRoute, withSessions } from './helpers.ts'

type Result = { ok: boolean; error?: string; [extra: string]: unknown }

export interface SessionApp {
  deps: Deps
  /** The board's launches, for a fork of a session (services/launch/fork.ts). */
  launches?: Pick<Launches, 'start' | 'list'>
  find(key: string): Item | undefined
  /** The board's items, for the sessions on the other end of a message. */
  items(): Item[]
  refresh(): void
  /** One message in flight per session (core/message-gate.ts). */
  gate: MessageGate
  /** Sessions with an answer being typed into their dialog. */
  answering: Set<string>
}

const changed = (item: Item): Result => ({ ok: false, error: t('err.sessionChanged', { name: item.name }) })
const PIN_NAMES: ReadonlySet<string> = PINS
const isPin = (column: string): column is Pin => PIN_NAMES.has(column)

async function detail(app: SessionApp, item: Item) {
  const { deps } = app
  const { transcript, claudeRoot, alive, since, pipe, ...shown } = item
  // queued: the user's messages Claude has not taken in yet. Only a running Claude has a queue,
  // and once it said its turn was over (its registry: idle, or a background shell) it had none.
  // The registry is the one of the session's own profile.
  const home = deps.homes.forDir(claudeRoot ?? deps.claude.root)
  const reg = alive && item.session ? home.liveSessions().get(item.session) : null
  const idleSince =
    reg && ['idle', 'shell'].includes(reg.status ?? '') && typeof reg.statusUpdatedAt === 'number'
      ? reg.statusUpdatedAt
      : 0
  // A pi session's turns are in its session file, its key.
  const thread = isPiItem(item)
    ? deps.pi.sessionThread(item.session ?? '', 60)
    : deps.claude.sessionThread(transcript ?? '', 60, { since: since ?? 0, idleSince })
  const conversation = withSessions(app.items(), thread.conversation)
  // helpers: every subagent, fork, workflow agent and teammate, newest first (adapters/helpers.ts).
  const own = helpersOf(transcript, { alive: !!alive, since: since ?? null })
  // checkout: whether its folder is in git, for the sheet's Changes button.
  const checkout = await isCheckout(item.cwd)
  let screen = ''
  let dialog: PublicDialog | null = null
  if (item.status === 'blocked' && item.pane) {
    try {
      const text = await herdrText(['agent', 'read', item.pane, '--source', 'visible'], 5000)
      screen = text
        .split('\n')
        .map(l => l.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .split('\n')
        .slice(-30)
        .join('\n')
      // The dialog on it, for the sheet to answer: a permission prompt goes by its fingerprint.
      dialog = publicDialog(parseDialog(text))
    } catch {}
  }
  const helpers = own.helpers.map(publicHelper)
  const queued = alive ? thread.queued : []
  return { item: shown, conversation, queued, helpers, workflows: own.workflows, screen, dialog, checkout }
}

function message(app: SessionApp, item: Item, body: Body): Promise<Result> {
  const { deps } = app
  // Attached files go as their paths: Claude reads them, and picks up image paths as images.
  const files = (Array.isArray(body.files) ? body.files : []).filter(
    (p): p is string => typeof p === 'string' && p.startsWith(uploadsDir()),
  )
  const list = files.length ? `${t('msg.files', { n: files.length })}:\n${files.join('\n')}` : ''
  // The card is for one session: a pane that holds another one now gets nothing. Panes with
  // no Claude session id (other agents) are matched by the card alone.
  if ((body.session ?? null) !== (item.session ?? null)) return Promise.resolve(changed(item))
  return app.gate(item.key, body.requestId ?? randomUUID(), [body.session ?? null, body.text, files], async () => {
    // Always collect a new snapshot before accepting a message, even if SSE is connected: a
    // board that cannot reach herdr fails here rather than send on old data.
    const fresh = (await collect(deps)).find(next => next.key === item.key)
    if (!fresh || fresh.session !== item.session || fresh.pane !== item.pane) return changed(item)
    return send(deps, fresh, [String(body.text ?? '').trim(), list].filter(Boolean).join('\n\n'))
  })
}

// A question form or a permission prompt, answered with keys in the pane (services/answer.ts).
async function answer(app: SessionApp, item: Item, action: 'answer' | 'permit', body: Body): Promise<Result> {
  const { deps, answering } = app
  if ((body.session ?? null) !== (item.session ?? null)) return changed(item)
  if (answering.has(item.key)) return { ok: false, error: t('err.qa.busy', { name: item.name }) }
  answering.add(item.key)
  try {
    // A new snapshot first, as for a message: the board must not answer on old data.
    let fresh: Item | undefined
    try {
      fresh = (await collect(deps)).find(next => next.key === item.key)
    } catch (err) {
      return { ok: false, error: t('err.qa.herdr', { why: err instanceof Error ? err.message : String(err) }) }
    }
    if (!fresh || fresh.session !== item.session || fresh.pane !== item.pane) return changed(item)
    const r = action === 'answer' ? await answerQuestions(deps, fresh, body) : await answerPermission(fresh, body)
    deps.log(`${action} ${item.name}: ${r.ok ? 'ok' : r.error}`)
    return r
  } finally {
    answering.delete(item.key)
  }
}

async function rename(item: Item, body: Body): Promise<Result> {
  // The board's own name for it, kept on the card; empty gives the automatic one back.
  const name = String(body.name ?? '').trim()
  const bad = name && checkName(name)
  if (bad) return { ok: false, error: t(bad) }
  // Claude and herdr only when the user asked for it: /rename is typed into the session.
  // The board keeps the name only once that went through, so a refusal changes nothing.
  const claude = body.claude && name ? await renameSession(item, name) : { ok: true }
  if (claude.ok) writeCard(item.key, { name })
  return claude
}

/** The board's own workspace, when it opens in one of its own ('' when it opens as a tab or over a pane). */
const boardWorkspace = (cfg: Deps['cfg']): string =>
  (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : ''

function card(item: Item, body: Body): Result {
  const patch: CardPatch = {}
  if (typeof body.category === 'string') patch.category = body.category.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (typeof body.wait === 'string')
    Object.assign(
      patch,
      body.wait.trim() ? { wait: body.wait.trim(), waitSince: Date.now() } : { wait: '', waitSince: '' },
      { by: 'user' },
    )
  if (typeof body.doing === 'string') patch.doing = body.doing.trim()
  // Kept in sight, or not any more.
  if (typeof body.favorite === 'boolean') patch.favorite = body.favorite || ''
  // A card dragged to another column stays there until the session works again; dropped
  // back where the board would put it by itself, it is unpinned.
  if (typeof body.column === 'string') {
    if (body.column === item.auto) Object.assign(patch, { pin: '', pinAt: '', pinBusy: '' })
    else if (isPin(body.column))
      Object.assign(patch, { pin: body.column, pinAt: Date.now(), pinBusy: busy(item.status) ? 1 : '' })
    else return { ok: false, error: t('err.pinWork', { col: t('q', { s: t('col.work') }) }) }
  }
  const unpin = { pin: '', pinAt: '', pinBusy: '' }
  if (body.clear) Object.assign(patch, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '' }, unpin)
  // "No reply needed": drop the agent's ask, and stop reading its last question as one.
  if (body.dismiss)
    Object.assign(
      patch,
      { ask: '', askSince: '', dismissed: item.attention === 'question' ? item.question : '' },
      unpin,
    )
  writeCard(item.key, patch)
  return { ok: true }
}

/**
 * A restart the user asked for: the scheduler does it once the session is free (a schedule entry
 * of kind 'restart'): herdr-wake puts it to sleep and wakes it again. Asleep, waking it is the
 * restart. One the board would not wake again (its profile guard) is refused here, before
 * anything is scheduled.
 */
async function restart(deps: SessionApp['deps'], item: Item): Promise<Result> {
  if (!item.session || !item.pane || item.agent !== 'claude')
    return { ok: false, error: t('err.restart.notClaude', { name: item.name }) }
  if (item.sleeping) return { ok: false, error: t('err.restart.asleep', { name: item.name }) }
  const up = await wakeAnswers(deps)
  if (!up.ok) return up
  const guard = await checkWake(deps, item)
  if (!guard.ok) return { ok: false, error: guard.error }
  const { entry, again } = askRestart({
    key: item.key,
    name: item.name,
    pane: item.pane,
    ...(item.cwd && { cwd: item.cwd }),
    by: 'user',
  })
  deps.log(`restart ${item.name}: ${again ? 'on its way already' : `asked, ${entry.id}`}`)
  return { ok: true, id: entry.id, again }
}

/** `body`: its fields, taken only by the actions that read them (as main's did, so a null body fails only there). */
async function act(app: SessionApp, item: Item, action: string, body: () => Promise<Body>): Promise<Result> {
  const { deps } = app
  switch (action) {
    case 'focus':
      return focus(deps, item, { raise: deps.cfg.raiseTerminal !== false })
    case 'wake':
      return item.sleeping ? wake(deps, item).finally(() => deps.wake.forget()) : { ok: true }
    case 'sleep':
      return sleepSession(deps, item).finally(() => deps.wake.forget())
    case 'restart':
      return restart(deps, item)
    case 'message':
      return message(app, item, await body())
    case 'answer':
    case 'permit':
      return answer(app, item, action, await body())
    case 'rename':
      return rename(item, await body())
    // herdr's name for the workspace it is in, which every session there shows.
    case 'workspace':
      return renameWorkspace(item, String((await body()).name ?? ''), boardWorkspace(deps.cfg))
    case 'card':
      return card(item, await body())
    // Off the board: hidden at once, its pane closed a few seconds later by the scheduler (services/archive.ts).
    case 'archive': {
      const grace = undoMs(deps.cfg)
      const r = await askArchive(deps, item, { by: 'user', grace })
      if (!r.ok) return { ok: false, why: r.why, error: t(r.why, { name: item.name, why: r.detail ?? '' }) }
      deps.log(
        `archive ${item.name}: asked, its pane closes in ${grace / 1000} s${r.held ? `, ${r.held} schedule entries held` : ''}`,
      )
      return { ok: true, held: r.held, dropped: r.dropped, closeAt: r.record.closeAt }
    }
    // A MokuPilot call whose agent is a fork of this session, only in the board's own profile; no herdr in it.
    case 'mokupilot':
      return startCall(deps.cfg, item, { profiles: deps.profiles() })
    // A new session in a new tab with a copy of this one's conversation; this one stays as it is.
    case 'fork':
      return app.launches
        ? forkSession(deps, { launches: app.launches, items: app.items }, item, await body())
        : { ok: false, error: `unknown action ${action}` }
    default:
      return { ok: false, error: `unknown action ${action}` }
  }
}

const gone = () => json(404, { error: t('err.gone') })

export function sessionRoutes(app: SessionApp): Route[] {
  /** The handler with the session its path names; gone by now answers as gone before. */
  const withItem =
    (handle: (item: Item, ...rest: Parameters<Handler>) => Promise<Response>): Handler =>
    (req, ctx) => {
      const item = app.find(ctx.params[0] ?? '')
      return item ? handle(item, req, ctx) : gone()
    }
  const action = withItem(async (item, _req, ctx) => {
    const what = ctx.params[1] ?? ''
    // Read for every action (too large or not JSON is a 500), its fields only where they are used.
    await ctx.rawBody()
    if (what === 'rename' && (await ctx.body()).claude) {
      const refused = ctx.refuse('fresh-data')
      if (refused) return refused
    }
    const r = await act(app, item, what, ctx.body)
    app.refresh()
    return json(r.ok ? 200 : 409, r)
  })
  return [
    {
      method: 'ANY',
      path: /^\/api\/session\/([^/]+)(?:\/(\w+))?$/,
      handle: (_req, ctx) => (app.find(ctx.params[0] ?? '') ? undefined : gone()),
    },
    {
      method: 'GET',
      path: /^\/api\/session\/([^/]+)\/changes$/,
      handle: withItem(async item => json(200, await checkoutChanges(item.cwd))),
    },
    {
      method: 'GET',
      path: /^\/api\/session\/([^/]+)\/history$/,
      // In the session's own profile: the folder its records were read from.
      handle: withItem(async (item, _req, ctx) => {
        const home = app.deps.homes.forDir(item.claudeRoot ?? app.deps.claude.root)
        return json(200, await home.searchHistory(item.cwd, ctx.url.searchParams.get('q'), item.session))
      }),
    },
    {
      method: 'GET',
      path: /^\/api\/session\/([^/]+)$/,
      handle: withItem(async item => json(200, await detail(app, item))),
    },
    helperRoute(app),
    // Answering a dialog presses keys in a session, an archive closes a pane, a workspace's new name
    // is every session's there, a fork starts one: like a launch, only from this page.
    {
      method: 'POST',
      path: /^\/api\/session\/([^/]+)\/(answer|permit|archive|workspace|fork)$/,
      guard: ['board-header', 'origin', 'fresh-data'],
      handle: action,
    },
    // A call starts a program: like a launch, only from this page; it needs no herdr.
    {
      method: 'POST',
      path: /^\/api\/session\/([^/]+)\/(mokupilot)$/,
      guard: ['board-header', 'origin'],
      handle: action,
    },
    // A side question runs Claude once on a copy of the conversation (services/aside.ts): like a
    // call, only from this page, no herdr; the page going away ends it.
    {
      method: 'POST',
      path: /^\/api\/session\/([^/]+)\/aside$/,
      guard: ['board-header', 'origin'],
      handle: withItem(async (item, req, ctx) => {
        const r = await askAside(app.deps, item, (await ctx.body()).question, { signal: req.signal })
        return json(r.ok ? 200 : 409, r)
      }),
    },
    // Actions that go through herdr wait for a board that can reach it; card edits and the rest do not.
    {
      method: 'POST',
      path: /^\/api\/session\/([^/]+)\/(focus|wake|sleep|restart|message)$/,
      guard: ['board-header', 'fresh-data'],
      handle: action,
    },
    { method: 'POST', path: /^\/api\/session\/([^/]+)\/(\w+)$/, guard: ['board-header'], handle: action },
  ]
}
