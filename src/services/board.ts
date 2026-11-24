// The board's data: every agent pane in herdr plus the sessions wake put to sleep (Claude's, and pi's, #178), each
// merged with its card and with what Claude recorded about it in its own profile's folder, and
// sorted into a column. Sessions in the archive are left out (services/archive.ts).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { allCards, writeCard } from '../adapters/cards.ts'
import type { ClaudeHome } from '../adapters/claude-home.ts'
import { helpersOf } from '../adapters/helpers.ts'
import { paneTerminals, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { LinksIndex } from '../adapters/links.ts'
import { callAgentsGate, taskBoard } from '../adapters/mokupilot-call.ts'
import { dayGate } from '../adapters/mokupilot-day.ts'
import { contextDir } from '../adapters/paths.ts'
import type { LiveHit } from '../adapters/profile-homes.ts'
import { AGY_AGENT, isAgyItem, isAgySession } from '../core/agy.ts'
import { bgTaskFromFooter, bgTaskStuckMin, summarizeBgTasks } from '../core/bg-task.ts'
import { attentionOf, busy, columnOf, isAgentStatus, PINS } from '../core/board.ts'
import { besideParents, type CallAgent, type CallView } from '../core/call-agent.ts'
import { categoryFor } from '../core/categories.ts'
import { isCodexItem } from '../core/codex.ts'
import { compactView } from '../core/compact.ts'
import { type CardDecision, cardDecisionOf, decisionsConfig } from '../core/decisions.ts'
import { waitingTool } from '../core/held-question.ts'
import { type HelperSummary, summarize } from '../core/helpers.ts'
import { t } from '../core/lang.ts'
import { slugName } from '../core/launch/names.ts'
import { relate } from '../core/links.ts'
import { lostAccessLine } from '../core/lost-access.ts'
import { modelCheck, modelsConfig } from '../core/model-check.ts'
import { isPiItem, isPiSessionFile, PI_AGENT, piSessionId } from '../core/pi.ts'
import { DEFAULT_PROFILE, sessionProfile } from '../core/profiles.ts'
import { pendingOf, requestsOf, type SecretView, secretViews } from '../core/secrets.ts'
import { numberTodos, type Todo, todosOf } from '../core/todos.ts'
import type { AgentStatus, Attention, Card, Config, Item, Pin, ToolCall, TranscriptInfo } from '../core/types.ts'
import { agySleeperPane } from '../core/wake/agy.ts'
import { piSleeperPane } from '../core/wake/pi.ts'
import { archivedFiles, getArchived, hides, isArchived, settleReturned } from './archive.ts'
import type { Deps } from './deps.ts'
import { secretsOf } from './secrets.ts'

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * Automatic display name for an Antigravity (`agy`) pane (#650): `agy` does not update the
 * terminal title, so prefer herdr's agent name, a non-numeric tab label (set by `spawn-agent
 * --name`), pane label, or conversation title before falling back to the shell's terminal title.
 */
export function agyAutoName(opts: {
  agentName?: string | undefined
  tabLabel?: string | undefined
  paneLabel?: string | undefined
  title?: string | undefined
  terminalTitle?: string | undefined
  paneId: string
}): string {
  const herdrName = opts.agentName?.trim() || ''
  const rawTab = opts.tabLabel?.trim() || ''
  const tabLabel = rawTab && !/^\d+$/.test(rawTab) ? rawTab : ''
  // Keep spawn-agent's original capitalization when herdr's lowercased slug matches the tab label.
  if (herdrName && tabLabel && slugName(tabLabel) === herdrName) return tabLabel
  if (herdrName) return herdrName
  if (tabLabel) return tabLabel
  const paneLabel = opts.paneLabel?.trim() || ''
  if (paneLabel) return paneLabel
  const title = opts.title?.trim() || ''
  if (title) return title
  return opts.terminalTitle?.trim() || opts.paneId
}

/** MokuPilot's call agents (#326), read only where it is not turned off and has run here (looked up once a minute). */
const callAgentsHere = callAgentsGate()
const daySessionHere = dayGate()

/** A card's open decision (#487), only while config.json turns decisions on and the card still asks. */
const decisionField = (cfg: Config, card: Card): { decision?: CardDecision } => {
  if (card.decision === undefined || !card.ask || !decisionsConfig(cfg.decisions)) return {}
  const decision = cardDecisionOf(card.decision)
  return decision ? { decision } : {}
}

/** The panes its card says wake closed as it went to sleep (#204, services/wake/follow.ts), when it has any. */
/** A card's tasks (#202) for its item, when it has any. */
/** A secret request's line on the card (#273), the newest one's, when no `board ask` says more. */
function secretAsk(card: Card): string {
  const last = pendingOf(requestsOf(card.secrets), Date.now()).at(-1)
  return last ? t('secret.asks', { title: last.title }) : ''
}

/** The card's pending secret requests (#273), each with where it writes; absent when none. */
const secretsField = (cfg: Config, card: Card): { secrets?: SecretView[] } => {
  if (!Array.isArray(card.secrets) || !pendingOf(requestsOf(card.secrets), Date.now()).length) return {}
  try {
    // the owner's sinks, and the calendar's own while it is on (#328): as the request and the submit see them
    const views = secretViews(secretsOf(cfg), card, t)
    return views.length ? { secrets: views } : {}
  } catch {
    return {} // a card any process wrote: what cannot be read of it never stops the board
  }
}

// Numbered as the next change will write them (#319), points made before numbers too.
const todosField = (card: Card): { todos?: Todo[] } => {
  const todos = todosOf(card.todos)
  return todos.length ? { todos: numberTodos(todos, Number(card.todoSeq) || 0).list } : {}
}

/** A call agent's card (#326, core/call-agent.ts) as the page gets it: its call and its task board. */
const callView = (a: CallAgent, key: string): CallView => ({
  phase: a.phase,
  since: a.started,
  parent: a.parent && a.parent !== key ? a.parent : null,
  helpers: a.helpers,
  tasks: taskBoard(a),
})

/**
 * A call agent's words from its transcript (`since`: when it started). A fork's transcript starts
 * with a copy of its parent's conversation, old times and all: its title, and what was said or
 * recapped before `since`, are the parent's. Its prompts are what MokuPilot feeds it from the
 * call. None of those on its card. One MokuPilot went on in (`inPlace`) has only its own words:
 * its title, last prompt and last words stay; a recap from before the call is of before the call.
 */
const callWords = (info: TranscriptInfo, since: number, inPlace: boolean) => {
  const recapped = (info.recapAt ?? 0) >= since
  const spoke = inPlace || (info.lastAt ?? 0) >= since
  return {
    title: inPlace ? (info.title ?? '') : '',
    prompt: inPlace ? (info.prompt ?? '') : '',
    lastText: spoke ? (info.lastText ?? '') : '',
    lastAt: spoke ? (info.lastAt ?? null) : null,
    recap: recapped ? (info.recap ?? '') : '',
    recapAt: recapped ? (info.recapAt ?? null) : null,
  }
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
function askedText(
  attention: Attention,
  card: Card,
  info: TranscriptInfo,
  tool: ToolCall | null,
  lostLine = '',
): string {
  if (attention === 'access') return lostLine
  if (attention === 'ask') return card.ask || secretAsk(card)
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
  /** The effort its last run reported; null: that run had none; undefined: written before effort was kept. */
  effort: string | null | undefined
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
    effort: typeof d.effort === 'string' && d.effort ? d.effort.slice(0, 20) : 'effort' in d ? null : undefined,
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
  /** `effort` is what Claude's status line last reported (#193): the card shows only that one. */
  effortLive?: true
  /** When `model` was reported: the status line's last run (its file's time), else its assistant line's time (server only). */
  modelAt: number | null
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
    modelAt: info.model ? (info.modelAt ?? null) : null,
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
    // A zero it counted is a count; no count leaves the transcript's.
    context: fresh && d.tokens != null ? d.tokens : own.context,
    contextPct: fresh ? (d.usedPercentage ?? null) : null,
    contextSize: d.size ?? null,
    model: d.model ?? own.model,
    // The status line's effort is the live one (a session-only /effort too, #193), and it runs again
    // on every change: what it said wins, none included, so a level it stopped reporting is not kept.
    // A file from before it was kept leaves the transcript's and the settings' as they were.
    effort: d.effort !== undefined ? d.effort : own.effort,
    ...(typeof d.effort === 'string' && { effortLive: true as const }),
    // The status line rewrites the file on every run, before the first reply too (a model, no tokens).
    modelAt: d.model ? st.mtimeMs : own.modelAt,
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
  | 'day'
  | 'bgTasks'
>

export interface CollectOptions {
  /** Each session's helpers (adapters/helpers.ts), for the web board. */
  helpers?: boolean
  /** How sessions work with each other: a links index (adapters/links.ts), for the web board. */
  links?: LinksIndex | null
  /** Told every pane in herdr's snapshot with the terminal it holds (null: herdr did not say), once collected. */
  seen?: (panes: ReadonlyMap<string, string | null>) => void
  /** Called when a background agy footer probe observes a task count change (#676). */
  onBgChange?: () => void
  observed?: (native: Awaited<ReturnType<typeof snapshot>>, items: readonly Item[]) => void
}

/**
 * All board items, newest activity first. The web board also asks for each session's helpers
 * (`helpers`: adapters/helpers.ts) and how sessions work with each other (`links`: an index), and
 * hears which panes herdr has (`seen`).
 */
export async function collect(
  deps: Deps,
  { helpers = false, links = null, seen: panesSeen = () => {}, onBgChange, observed }: CollectOptions = {},
): Promise<Item[]> {
  const { cfg } = deps
  // The model rule (#429): null while config.json has none, and then nothing below reads it.
  const models = modelsConfig(cfg.models)
  const [snap, asleep] = await Promise.all([snapshot(), deps.wake.sleepers()])
  // The registries of every profile, hidden ones too (their running sessions keep their names and
  // titles), and of the folder the board's own env points to.
  const profiles = deps.profiles()
  const shownProfileCount = profiles.list.filter(p => !p.hidden).length
  const dirs = [profiles.inheritedDir, ...profiles.list.map(p => p.dir)]
  const searched = [...new Set(dirs.map(dir => deps.homes.forDir(dir)))]
  const live = deps.homes.liveSessions(dirs)
  const cards = allCards()
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const hasAgyPane = snap.panes.some(p => p.agent === AGY_AGENT)
  const tabLabels = hasAgyPane ? new Map(snap.tabs.map(tab => [tab.tab_id, tab.label ?? ''])) : null
  const agentNames = hasAgyPane ? new Map((snap.agents ?? []).map(a => [a.pane_id, a.name ?? ''])) : null
  const now = Date.now()
  const stuckMin = bgTaskStuckMin(cfg.bgTaskStuckMin)
  const agyMeta = new Map<
    string,
    {
      session: string | null
      info: TranscriptInfo | null
      runningSubagent: boolean
      footer: { count: number; since: number } | null
    }
  >()
  if (hasAgyPane) {
    for (const p of snap.panes) {
      if (p.agent !== AGY_AGENT) continue
      const rawSession = p.agent_session?.value ?? null
      // If herdr's PreInvocation hook reported an agy subagent UUID, resolve back to its root conversation (#650).
      const session = rawSession ? (deps.agy.rootSession(rawSession) ?? rawSession) : null
      const info = session ? deps.agy.transcriptInfo(session) : null
      const runningSubagent = !!session && deps.agy.hasRunningSubagent(session)
      const st = isAgentStatus(p.agent_status) ? p.agent_status : 'unknown'
      const footer =
        st !== 'blocked' && st !== 'working' && !runningSubagent && !info?.bgTasks?.length && deps.agyFooter
          ? deps.agyFooter.peek(p.pane_id, p.terminal_id ?? '', now, onBgChange)
          : null
      agyMeta.set(p.pane_id, { session, info, runningSubagent, footer })
    }
  }
  const items: Item[] = []
  const seen = new Set<string>()
  const archived = archivedFiles()

  // A MokuPilot call agent (#326) runs with no pane and no hook: its card is told the Claude folder
  // MokuPilot started it in, where its records are, unless its own card says one.
  const add = (base: Base, call?: CallAgent, parent?: Item, preloadedAgy?: TranscriptInfo | null): void => {
    if (isArchived(archived, base.key)) {
      const record = getArchived(base.key)
      if (hides(record, base)) return
      // In another pane than the one it was archived in: it is back (Return, or resumed by hand).
      // MokuPilot going on in it for a call (#326) is no return: it shows while the call lasts.
      if (record && !call) {
        try {
          settleReturned(base)
        } catch {} // its record is locked: the next refresh settles it
      }
    }
    const saved = cards.get(base.key) ?? {}
    // Moved to another device (#616, services/move-out.ts): its card there is the one; this one,
    // asleep here, is left out until it comes back (a move back clears the mark) or runs here again.
    if (base.sleeping && movedAway(saved)) return
    const pin = pinOf(base.key, base.status, saved)
    const hit = base.session ? live.get(base.session) : undefined
    // A MokuPilot day session (#331) has no hook to report its profile either: the folder whose
    // registry runs it.
    const card: Card = {
      ...saved,
      pin,
      ...(call && !saved.profileDir && { profileDir: call.configDir || join(homedir(), '.claude') }),
      ...(base.day && !saved.profileDir && hit && { profileDir: hit.home.root }),
    }
    // A pi session's records are its session file, its key: none of Claude's folders has them.
    const pi = isPiItem(base) ? (deps.pi.transcriptInfo(base.session) ?? {}) : null
    const codex = isCodexItem(base) ? (deps.codex.transcriptInfo(base.session) ?? {}) : null
    const agy = isAgyItem(base)
      ? preloadedAgy !== undefined
        ? (preloadedAgy ?? {})
        : (deps.agy.transcriptInfo(base.session) ?? {})
      : null
    const { home, path } =
      pi || codex || agy ? { home: null, path: null } : recordsOf(deps, card, base.session, base.cwd, hit, searched)
    const info = agy ?? codex ?? pi ?? home?.transcriptInfo(path) ?? {}
    // The name given to a pi session (/name) is what herdr and pi know it by, as a Claude's /rename.
    const autoName = pi?.name || base.name
    const guess = categoryFor(cfg, base.cwd)
    // A Claude session's question form can be the hook's still (core/held-question.ts).
    const tool = pi || codex || agy ? (info.tool ?? null) : waitingTool(base.status, info, card.asking)
    // A fork or call starts from copied transcript history: ignore lost-access errors recorded before it began.
    const rawLost = info.lostAccess
    const floorAt = call ? call.started : typeof card.forkAt === 'number' ? card.forkAt : 0
    const lostAccess = rawLost && (!floorAt || !rawLost.at || rawLost.at >= floorAt) ? rawLost : undefined
    // Latest active TodoWrite checklist (#637): Claude sessions only, ignoring copied fork/call lines.
    const rawChecklist = !pi && !codex && !agy && base.agent === 'claude' ? info.checklist : undefined
    const checklist =
      rawChecklist && (!floorAt || !rawChecklist.at || rawChecklist.at >= floorAt) ? rawChecklist : undefined
    // A call agent's last words go to the call, its questions too: only its `board ask` asks the user.
    const { lostAccess: _ignored, ...restInfo } = info
    const told: TranscriptInfo = {
      ...(call ? { ...restInfo, question: '' } : restInfo),
      ...(lostAccess && { lostAccess }),
    }
    const attention = attentionOf(base.status, card, told)
    const sp = sessionProfile(card, profiles.list)
    const profileRow = !pi && !codex && !agy && sp.profile ? profiles.list.find(p => p.id === sp.profile) : undefined
    const lostProfileTitle =
      profileRow && (shownProfileCount >= 2 || profileRow.hidden || profileRow.id !== DEFAULT_PROFILE)
        ? profileRow.title || profileRow.id
        : null
    const lostLine = lostAccess ? lostAccessLine(lostAccess, lostProfileTitle, t) : ''
    const callOf = call ? callView(call, base.key) : null
    // Its own words on the board, else what its task board says it does.
    const doing = card.doing || callOf?.tasks.find(x => x.status === 'doing')?.text || ''
    const { modelAt, ...context } = contextOf(codex || agy ? null : base.session, info, home?.root ?? null) // Codex and Antigravity have no Claude status line file.
    const name = card.name || autoName
    // A call agent goes in its parent's lane, unless its own card says another.
    const category = card.category || parent?.category || guess || 'other'
    // Its model against the rule (#429), once this start has reported one: a model read before it
    // started is the one it had before a restart or a wake.
    const fresh = !base.since || (modelAt ?? 0) >= base.since
    const modelWrong =
      models && fresh ? modelCheck({ ...base, name, category, model: context.model }, card, models) : null
    // Auto-compact (#378): a Claude session in a pane of its own, only where it or Settings has a
    // limit, instructions or a run to show.
    const compact =
      base.agent === 'claude' && !base.day && !call ? compactView(card, cfg.compact, context.contextSize) : null
    const transcriptPath = agy ? deps.agy.transcriptPath(base.session) : path
    let own: HelperSummary | null = null
    if (helpers && agy && base.session) {
      try {
        own = summarize(deps.agy.sessionHelpers(base.session))
      } catch {}
    } else if (helpers && path) {
      try {
        own = summarize(helpersOf(path, { alive: !!base.alive, since: base.since ?? null }))
      } catch {} // helpers that cannot be read leave the session's card as it was
    }
    items.push({
      ...base,
      // A name given on the board beats the one herdr and Claude know it by; autoName is theirs.
      name,
      autoName,
      category,
      categorySet: !!card.category,
      doing,
      // A card written before doingAt (#321): its last change, the latest the doing can be from.
      doingAt: card.doing ? (card.doingAt ?? card.updatedAt ?? null) : doing && call ? call.updated : null,
      wait: card.wait ?? '',
      waitSince: card.waitSince ?? null,
      result: card.result ?? '',
      // A call agent's title and recap from before its call are its parent's, copied with the
      // conversation; its prompts are what MokuPilot feeds it from the call.
      ...(call
        ? callWords(info, call.started, call.parent === call.session)
        : {
            title: info.title ?? '',
            prompt: info.prompt ?? '',
            lastText: info.lastText ?? '',
            lastAt: info.lastAt ?? null,
            recap: info.recap ?? '',
            recapAt: info.recapAt ?? null,
          }),
      // its last words are an API error (#489, the away journal's "stopped on an error"); off the payload
      ...(info.apiError && { apiError: true as const }),
      ...(lostAccess && { lostAccess }),
      ...context,
      tool,
      attention,
      question: askedText(attention, card, told, tool, lostLine),
      askSince: attention === 'ask' ? (card.askSince ?? null) : attention === 'access' ? lostAccess?.at || null : null,
      activity: info.activity ?? base.activity ?? 0,
      column: columnOf(base.status, card, told),
      pin, // the column the user dragged it to, or ''
      auto: columnOf(base.status, { ...card, pin: '' }, told), // where it would be without the pin
      ...(card.favorite === true && { favorite: true }), // the user keeps it in sight
      ...todosField(card), // its tasks (#202), when it has any
      ...(checklist && { checklist }), // its active TodoWrite checklist (#637), Claude only
      ...(base.bgTasks && !base.sleeping && { bgTasks: base.bgTasks }), // running background tasks (#676), agy only
      ...(compact && { compact }), // its auto-compact (#378), when there is any
      ...secretsField(cfg, card), // what it asks the user to fill in (#273), when it does
      ...decisionField(cfg, card), // its open question's options and default (#487), while decisions are on
      helpers: own, // its subagents, forks, workflow agents and teammates in short, or null
      // a fork's card says whose fork it is, and when it started; a call agent's file says it
      ...(typeof card.forkOf === 'string'
        ? { fork: { of: card.forkOf, at: Number(card.forkAt) || 0 } }
        : callOf?.parent && { fork: { of: callOf.parent, at: callOf.since } }),
      ...(callOf && { call: callOf }), // a MokuPilot call agent (#326): its call and its task board
      // the model its start asked for (#380), when not the profile's default
      ...(typeof card.modelWant === 'string' && card.modelWant && { modelAsked: card.modelWant }),
      ...(modelWrong && { modelWrong }), // another model than config.json's `models` expects (#429)
      transcript: transcriptPath,
      ...formerPanes(card), // panes wake closed as it went to sleep (#204), for the links
      ...sp, // its profile, as its hooks reported it
      claudeRoot: home?.root ?? null, // the folder its records were read from
    })
  }

  // MokuPilot's day session (#331), while its Claude process runs. The pane MokuPilot runs in is
  // where herdr sees it; typing there reaches MokuPilot's console, not the session, so that pane's
  // card is the day's, with no pane: its messages go to the day's inbox.
  const day = daySessionHere(cfg)
  const dayReg = day ? live.get(day.session)?.session : undefined
  const dayPane = (p: (typeof snap.panes)[number], session: string | null): boolean =>
    !!day && !!dayReg && (session === day.session || (!session && !!day.pane && p.pane_id === day.pane))
  let dayWorkspace = ''

  for (const p of snap.panes) {
    if (!p.agent) continue
    const agyPane = p.agent === AGY_AGENT
    const meta = agyPane ? agyMeta.get(p.pane_id) : undefined
    const session = agyPane ? (meta?.session ?? null) : (p.agent_session?.value ?? null)
    if (dayPane(p, session)) {
      dayWorkspace ||= labels.get(p.workspace_id ?? '') ?? ''
      continue
    }
    const key = session ?? `pane-${p.pane_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const reg = session ? live.get(session)?.session : null
    let status: AgentStatus = isAgentStatus(p.agent_status) ? p.agent_status : 'unknown'
    if (agyPane && status !== 'blocked' && meta?.runningSubagent) status = 'working'
    const bgTasks = agyPane
      ? meta?.info?.bgTasks?.length
        ? summarizeBgTasks(meta.info.bgTasks, stuckMin, now)
        : meta?.footer
          ? bgTaskFromFooter(meta.footer.count, meta.footer.since, stuckMin, now)
          : null
      : null
    if (bgTasks && status !== 'blocked') status = 'working'
    const name = agyPane
      ? agyAutoName({
          agentName: agentNames?.get(p.pane_id) || p.name,
          tabLabel: p.tab_id ? tabLabels?.get(p.tab_id) : undefined,
          paneLabel: p.label,
          title: session ? deps.agy.sessionTitle(session) : undefined,
          terminalTitle: p.terminal_title_stripped,
          paneId: p.pane_id,
        })
      : reg?.name || p.terminal_title_stripped || p.label || p.pane_id
    add(
      {
        key,
        session,
        pane: p.pane_id,
        workspace: labels.get(p.workspace_id ?? '') ?? '',
        agent: p.agent,
        name,
        cwd: p.cwd ?? reg?.cwd ?? '',
        status,
        sleeping: false,
        focused: p.pane_id === snap.focused_pane_id,
        activity: numberOf(reg?.statusUpdatedAt) ?? 0,
        // Its Claude process: whether it runs, since when, and the pipe other sessions write to.
        alive: !!reg,
        since: numberOf(reg?.startedAt) ?? null,
        pipe: typeof reg?.messagingSocketPath === 'string' ? reg.messagingSocketPath : '',
        ...(bgTasks && { bgTasks }),
      },
      undefined,
      undefined,
      agyPane ? (meta?.info ?? null) : undefined,
    )
  }

  if (day && dayReg && !seen.has(day.session)) {
    seen.add(day.session)
    add({
      key: day.session,
      session: day.session,
      pane: null,
      workspace: dayWorkspace,
      agent: 'claude',
      name: dayReg.name || day.session.slice(0, 8),
      cwd: dayReg.cwd ?? '',
      status: dayReg.status === 'busy' ? 'working' : 'idle',
      sleeping: false,
      focused: false,
      activity: numberOf(dayReg.statusUpdatedAt) ?? 0,
      alive: true,
      since: numberOf(dayReg.startedAt) ?? null,
      pipe: typeof dayReg.messagingSocketPath === 'string' ? dayReg.messagingSocketPath : '',
      day: true,
    })
  }

  // MokuPilot's call agents (#326): one in a pane already is marked there; a sleeper of the same
  // session is the call agent now (MokuPilot went on in it); the rest are added once the sessions
  // they are forks of are on the board.
  const calls = callAgentsHere(cfg)
  const onCall: CallAgent[] = []
  for (const a of calls) {
    if (seen.has(a.session)) continue
    seen.add(a.session)
    onCall.push(a)
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
    if (s.agent === AGY_AGENT) {
      // An Antigravity (`agy`) session asleep (#631), from wake's answer or its file: shown whether
      // its pane is still its own (then with it) or not (it wakes in a new tab).
      if (!isAgySession(s.session)) continue
      seen.add(s.session)
      const name = s.name ?? ''
      const cwd = s.cwd ?? ''
      const own = s.fromFile ? agySleeperPane(snap, { pane: s.pane ?? '', name, cwd })?.pane_id : s.pane
      const ws = own ? panes.get(own)?.workspace_id : undefined
      add({
        key: s.session,
        session: s.session,
        pane: own || null,
        workspace: (ws === undefined ? undefined : labels.get(ws)) ?? s.workspace ?? '',
        agent: AGY_AGENT,
        name: name || deps.agy.sessionTitle(s.session) || s.session.slice(0, 8),
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

  for (const a of onCall) {
    const parent = a.parent && a.parent !== a.session ? items.find(i => i.session === a.parent) : undefined
    // MokuPilot went on in a sleeping session: its card, by its name and in its workspace.
    const slept = asleep.find(s => s.session === a.session)
    add(
      {
        key: a.session,
        session: a.session,
        pane: null,
        workspace:
          parent?.workspace ??
          (slept ? (labels.get(panes.get(slept.pane ?? '')?.workspace_id ?? '') ?? slept.workspace ?? '') : ''),
        agent: a.harness,
        name: parent ? t('call.of', { name: parent.name }) : slept?.name || t('call.alone'),
        cwd: a.cwd || parent?.cwd || '',
        status: a.busy ? 'working' : 'idle',
        sleeping: false,
        focused: false,
        activity: a.updated,
        alive: true,
        since: a.started,
        pipe: '',
      },
      a,
      parent,
    )
  }
  for (const a of calls) {
    const it = onCall.includes(a) ? undefined : items.find(i => i.key === a.session)
    if (it) it.call = callView(a, it.key)
  }

  // Favorites first in their columns, then the latest activity first; a call agent right after
  // the session it is a fork of.
  items.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.activity ?? 0) - (a.activity ?? 0))
  if (calls.length) items.splice(0, items.length, ...besideParents(items))
  if (links) {
    links.update(items.map(i => i.transcript))
    const rel = relate(items, it => links.events(it.transcript))
    for (const it of items) {
      const l = rel.get(it.key)
      it.links = l && (l.from || l.started.length || l.talks.length) ? l : null
    }
  }
  panesSeen(paneTerminals(snap))
  observed?.(snap, items)
  return items
}

/** A card marked moved to another device (#616, services/move-out.ts finish). */
function movedAway(card: Card): boolean {
  const m = card.moved
  return typeof m === 'object' && m !== null && typeof (m as { to?: unknown }).to === 'string'
}
