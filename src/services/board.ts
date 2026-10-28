// The board's data: every agent pane in herdr plus the sessions wake put to sleep (Claude's, and pi's, #178), each
// merged with its card and with what Claude recorded about it in its own profile's folder, and
// sorted into a column. Sessions in the archive are left out (services/archive.ts).
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { allCards, writeCard } from '../adapters/cards.ts'
import type { ClaudeHome } from '../adapters/claude-home.ts'
import { helpersOf } from '../adapters/helpers.ts'
import { paneTerminals, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { LinksIndex } from '../adapters/links.ts'
import { contextDir } from '../adapters/paths.ts'
import type { LiveHit } from '../adapters/profile-homes.ts'
import { attentionOf, busy, columnOf, isAgentStatus, PINS } from '../core/board.ts'
import { categoryFor } from '../core/categories.ts'
import { isCodexItem } from '../core/codex.ts'
import { waitingTool } from '../core/held-question.ts'
import { type HelperSummary, summarize } from '../core/helpers.ts'
import { t } from '../core/lang.ts'
import { relate } from '../core/links.ts'
import { isPiItem, isPiSessionFile, PI_AGENT, piSessionId } from '../core/pi.ts'
import { sessionProfile } from '../core/profiles.ts'
import { type Todo, todosOf } from '../core/todos.ts'
import type { AgentStatus, Attention, Card, Item, Pin, ToolCall, TranscriptInfo } from '../core/types.ts'
import { piSleeperPane } from '../core/wake/pi.ts'
import { archivedFiles, getArchived, hides, isArchived, settleReturned } from './archive.ts'
import type { Deps } from './deps.ts'

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/** The panes its card says wake closed as it went to sleep (#204, services/wake/follow.ts), when it has any. */
/** A card's tasks (#202) for its item, when it has any. */
const todosField = (card: Card): { todos?: Todo[] } => {
  const todos = todosOf(card.todos)
  return todos.length ? { todos } : {}
}

const formerPanes = (card: Card): { formerPanes?: string[] } => {
  const panes = Array.isArray(card.panes)
    ? card.panes.filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  return panes.length ? { formerPanes: panes } : {}
}

/**
 * The column the user dragged the card to, or ''. It holds until the session works again (the
 * user or another session wrote to it); a card dragged during a turn (card.pinBusy) lands there
 * once that turn is over. Spent pins are taken off the card file here; a write that fails (its
 * card is locked) is tried again on the next refresh instead of failing this one.
 */
function pinOf(key: string, status: AgentStatus, card: Card): Pin | '' {
  const pin = card.pin
  if (!pin || !PINS.has(pin)) return ''
  const save = (patch: Partial<Card>): void => {
    try {
      writeCard(key, patch)
    } catch {}
  }
  if (card.pinBusy) {
    if (!busy(status)) save({ pinBusy: '' })
  } else if (busy(status)) {
    save({ pin: '', pinAt: '', pinBusy: '' })
    return ''
  }
  return pin
}

/** What the user is asked, for the card. */
function askedText(attention: Attention, card: Card, info: TranscriptInfo, tool: ToolCall | null): string {
  if (attention === 'ask') return card.ask ?? ''
  if (attention === 'question') return info.question ?? ''
  if (attention !== 'decision' || !tool?.pending) return ''
  return tool.name === 'AskUserQuestion'
    ? (tool.detail ?? '')
    : t('note.permission', { what: `${tool.label}${tool.detail ? ` · ${tool.detail}` : ''}` })
}

interface ContextFile {
  at: number | undefined
  tokens: number | undefined
  usedPercentage: number | undefined
  size: number | undefined
  model: string | undefined
}

const contextCache = new Map<string, { mtimeMs: number; data: ContextFile }>() // session -> file

function asContextFile(value: unknown): ContextFile {
  const d = isRecord(value) ? value : {}
  return {
    at: numberOf(d.at),
    tokens: numberOf(d.tokens),
    usedPercentage: numberOf(d.usedPercentage),
    size: numberOf(d.size),
    model: typeof d.model === 'string' && d.model ? d.model : undefined,
  }
}

/**
 * How full a session's context is. The status line (entrypoints/statusline.ts) says it best, percentage and
 * window size included; without it, the tokens of the last request from the transcript.
 */
interface ContextFill {
  context: number | null
  contextPct: number | null
  contextSize: number | null
  model: string | null
  effort: string | null
}

const effortCache = new Map<string, { mtimeMs: number; effort: string | null }>()

/** The effort the session's profile settings give its model now (a /effort writes it there). */
function effortFromSettings(dir: string | null, model: string | null): string | null {
  if (!dir) return null
  const file = join(dir, 'settings.json')
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st) return null
  const key = `${file}|${model ?? ''}`
  const hit = effortCache.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.effort
  let effort: string | null = null
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    if (isRecord(d)) {
      const settings = isRecord(d.modelSettings) ? d.modelSettings : {}
      const modelSettings = model ? settings[model] : undefined
      const perModel = isRecord(modelSettings) ? modelSettings.effortLevel : undefined
      if (typeof perModel === 'string' && perModel) effort = perModel
      else if (typeof d.effortLevel === 'string' && d.effortLevel) effort = d.effortLevel
    }
  } catch {}
  effortCache.set(key, { mtimeMs: st.mtimeMs, effort })
  return effort
}

function contextOf(session: string | null, info: TranscriptInfo, settingsDir: string | null = null): ContextFill {
  const own: ContextFill = {
    context: info.context ?? null,
    contextPct: null,
    contextSize: null,
    model: info.model ?? null,
    effort: info.effort ?? effortFromSettings(settingsDir, info.model ?? null),
  }
  if (!session) return own
  const file = join(contextDir(), `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st) return own
  let hit = contextCache.get(session)
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    try {
      hit = { mtimeMs: st.mtimeMs, data: asContextFile(JSON.parse(readFileSync(file, 'utf8'))) }
      contextCache.set(session, hit)
    } catch {
      return own
    }
  }
  const d = hit.data
  // The transcript can be newer (a reply the status line has not run for yet): its tokens win then.
  const fresh = !info.activity || (d.at !== undefined && d.at >= info.activity - 5000)
  return {
    context: (fresh && d.tokens) || own.context,
    contextPct: fresh ? (d.usedPercentage ?? null) : null,
    contextSize: d.size ?? null,
    model: d.model ?? own.model,
    effort: own.effort,
  }
}

/**
 * The Claude home a session's records (transcript, title, helpers) are read from, with its
 * transcript: the folder its card reports it runs in, else the one whose registry has it running,
 * else the first of `searched` that has its transcript; null when none has.
 */
function recordsOf(
  deps: Deps,
  card: Card,
  session: string | null,
  cwd: string,
  hit: LiveHit | undefined,
  searched: readonly ClaudeHome[],
): { home: ClaudeHome | null; path: string | null } {
  // A folder named relative to wherever its session ran is no folder the board can find.
  const reported = typeof card.profileDir === 'string' && isAbsolute(card.profileDir) ? card.profileDir : ''
  const home = reported ? deps.homes.forDir(reported) : hit?.home
  if (home) return { home, path: session ? home.transcriptPath(session, cwd) : null }
  if (session)
    for (const h of searched) {
      const path = h.transcriptPath(session, cwd)
      if (path) return { home: h, path }
    }
  return { home: null, path: null }
}

/** What a pane or a sleeper tells before the card and the transcript are merged in. */
type Base = Pick<
  Item,
  | 'key'
  | 'session'
  | 'pane'
  | 'workspace'
  | 'agent'
  | 'name'
  | 'cwd'
  | 'status'
  | 'sleeping'
  | 'focused'
  | 'activity'
  | 'alive'
  | 'since'
  | 'pipe'
  | 'fromFile'
>

export interface CollectOptions {
  /** Each session's helpers (adapters/helpers.ts), for the web board. */
  helpers?: boolean
  /** How sessions work with each other: a links index (adapters/links.ts), for the web board. */
  links?: LinksIndex | null
  /** Told every pane in herdr's snapshot with the terminal it holds (null: herdr did not say), once collected. */
  seen?: (panes: ReadonlyMap<string, string | null>) => void
}

/**
 * All board items, newest activity first. The web board also asks for each session's helpers
 * (`helpers`: adapters/helpers.ts) and how sessions work with each other (`links`: an index), and
 * hears which panes herdr has (`seen`).
 */
export async function collect(
  deps: Deps,
  { helpers = false, links = null, seen: panesSeen = () => {} }: CollectOptions = {},
): Promise<Item[]> {
  const { cfg } = deps
  const [snap, asleep] = await Promise.all([snapshot(), deps.wake.sleepers()])
  // The registries of every profile, hidden ones too (their running sessions keep their names and
  // titles), and of the folder the board's own env points to.
  const profiles = deps.profiles()
  const dirs = [profiles.inheritedDir, ...profiles.list.map(p => p.dir)]
  const searched = [...new Set(dirs.map(dir => deps.homes.forDir(dir)))]
  const live = deps.homes.liveSessions(dirs)
  const cards = allCards()
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const items: Item[] = []
  const seen = new Set<string>()
  const archived = archivedFiles()

  const add = (base: Base): void => {
    if (isArchived(archived, base.key)) {
      const record = getArchived(base.key)
      if (hides(record, base)) return
      // In another pane than the one it was archived in: it is back (Return, or resumed by hand).
      if (record) {
        try {
          settleReturned(base)
        } catch {} // its record is locked: the next refresh settles it
      }
    }
    const saved = cards.get(base.key) ?? {}
    const pin = pinOf(base.key, base.status, saved)
    const card: Card = { ...saved, pin }
    const hit = base.session ? live.get(base.session) : undefined
    // A pi session's records are its session file, its key: none of Claude's folders has them.
    const pi = isPiItem(base) ? (deps.pi.transcriptInfo(base.session) ?? {}) : null
    const codex = isCodexItem(base) ? (deps.codex.transcriptInfo(base.session) ?? {}) : null
    const { home, path } =
      pi || codex ? { home: null, path: null } : recordsOf(deps, card, base.session, base.cwd, hit, searched)
    const info = codex ?? pi ?? home?.transcriptInfo(path) ?? {}
    // The name given to a pi session (/name) is what herdr and pi know it by, as a Claude's /rename.
    const autoName = pi?.name || base.name
    const guess = categoryFor(cfg, base.cwd)
    // A Claude session's question form can be the hook's still (core/held-question.ts).
    const tool = pi || codex ? (info.tool ?? null) : waitingTool(base.status, info, card.asking)
    const attention = attentionOf(base.status, card, info)
    let own: HelperSummary | null = null
    if (helpers && path) {
      try {
        own = summarize(helpersOf(path, { alive: !!base.alive, since: base.since ?? null }))
      } catch {} // helpers that cannot be read leave the session's card as it was
    }
    items.push({
      ...base,
      // A name given on the board beats the one herdr and Claude know it by; autoName is theirs.
      name: card.name || autoName,
      autoName,
      category: card.category || guess || 'other',
      categorySet: !!card.category,
      doing: card.doing ?? '',
      wait: card.wait ?? '',
      waitSince: card.waitSince ?? null,
      result: card.result ?? '',
      title: info.title ?? '',
      prompt: info.prompt ?? '',
      lastText: info.lastText ?? '',
      ...contextOf(codex ? null : base.session, info, home?.root ?? null), // Codex has no Claude status line file.
      tool,
      attention,
      question: askedText(attention, card, info, tool),
      askSince: attention === 'ask' ? (card.askSince ?? null) : null,
      activity: info.activity ?? base.activity ?? 0,
      column: columnOf(base.status, card, info),
      pin, // the column the user dragged it to, or ''
      auto: columnOf(base.status, { ...card, pin: '' }, info), // where it would be without the pin
      ...(card.favorite === true && { favorite: true }), // the user keeps it in sight
      ...todosField(card), // its tasks (#202), when it has any
      helpers: own, // its subagents, forks, workflow agents and teammates in short, or null
      // a fork's card says whose fork it is, and when it started
      ...(typeof card.forkOf === 'string' && { fork: { of: card.forkOf, at: Number(card.forkAt) || 0 } }),
      transcript: path,
      ...formerPanes(card), // panes wake closed as it went to sleep (#204), for the links
      ...sessionProfile(card, profiles.list), // its profile, as its hooks reported it
      claudeRoot: home?.root ?? null, // the folder its records were read from
    })
  }

  for (const p of snap.panes) {
    if (!p.agent) continue
    const session = p.agent_session?.value ?? null
    const key = session ?? `pane-${p.pane_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const reg = session ? live.get(session)?.session : null
    add({
      key,
      session,
      pane: p.pane_id,
      workspace: labels.get(p.workspace_id ?? '') ?? '',
      agent: p.agent,
      name: reg?.name || p.terminal_title_stripped || p.label || p.pane_id,
      cwd: p.cwd ?? reg?.cwd ?? '',
      status: isAgentStatus(p.agent_status) ? p.agent_status : 'unknown',
      sleeping: false,
      focused: p.pane_id === snap.focused_pane_id,
      activity: numberOf(reg?.statusUpdatedAt) ?? 0,
      // Its Claude process: whether it runs, since when, and the pipe other sessions write to.
      alive: !!reg,
      since: numberOf(reg?.startedAt) ?? null,
      pipe: typeof reg?.messagingSocketPath === 'string' ? reg.messagingSocketPath : '',
    })
  }

  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  for (const s of asleep) {
    if (!s.session || seen.has(s.session)) continue
    if (s.agent === PI_AGENT) {
      // A pi session asleep (#178), from wake's answer or its file: shown whether its pane is
      // still its own (then with it) or not (it wakes in a new tab), under its session file's key.
      if (!isPiSessionFile(s.session)) continue
      seen.add(s.session)
      const name = s.name ?? ''
      const cwd = s.cwd ?? ''
      const own = s.fromFile ? piSleeperPane(snap, { pane: s.pane ?? '', name, cwd })?.pane_id : s.pane
      const ws = own ? panes.get(own)?.workspace_id : undefined
      add({
        key: s.session,
        session: s.session,
        pane: own || null,
        workspace: (ws === undefined ? undefined : labels.get(ws)) ?? s.workspace ?? '',
        agent: PI_AGENT,
        name: name || piSessionId(s.session).slice(0, 8),
        cwd,
        status: 'sleeping',
        sleeping: true,
        focused: false,
        activity: Date.parse(s.slept_at ?? '') || 0,
        ...(s.fromFile && { fromFile: true }),
      })
      continue
    }
    const pane = panes.get(s.pane ?? '')
    // One from wake's session file only where herdr shows its pane as a shell: not one whose pane
    // runs Claude (or another agent) again, nor one whose pane is gone. Its workspace is herdr's.
    // One whose pane wake closed (#204) has none: it wakes in a new tab, its workspace the file's.
    if (s.fromFile && s.pane && (!pane || pane.agent)) continue
    seen.add(s.session)
    add({
      key: s.session,
      session: s.session,
      pane: s.pane || null,
      workspace: s.fromFile && s.pane ? (labels.get(pane?.workspace_id ?? '') ?? '') : (s.workspace ?? ''),
      agent: 'claude',
      name: s.name || s.session.slice(0, 8),
      cwd: pane?.cwd ?? s.cwd ?? '',
      status: 'sleeping',
      sleeping: true,
      focused: false,
      activity: Date.parse(s.slept_at ?? '') || 0,
      ...(s.fromFile && { fromFile: true }),
    })
  }

  // Favorites first in their columns, then the latest activity first.
  items.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.activity ?? 0) - (a.activity ?? 0))
  if (links) {
    links.update(items.map(i => i.transcript))
    const rel = relate(items, it => links.events(it.transcript))
    for (const it of items) {
      const l = rel.get(it.key)
      it.links = l && (l.from || l.started.length || l.talks.length) ? l : null
    }
  }
  panesSeen(paneTerminals(snap))
  return items
}
