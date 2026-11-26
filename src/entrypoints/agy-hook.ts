// Installed only in Antigravity CLI's `~/.gemini/config/hooks.json`.
// Antigravity CLI expects a JSON object on stdout on every exit path (`{}` when injecting nothing).
// A pane's reported identity gates all card writes; a SessionStart or first PreInvocation that
// races herdr's PreInvocation identity hook is still briefed while herdr reports the pane as `agy`.
import { homedir } from 'node:os'
import { type CardPatch, readCard, writeCard } from '../adapters/cards.ts'
import { loadConfig, readConfigFile } from '../adapters/config-file.ts'
import { agentGet } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { nodeMasterFlags } from '../adapters/master-flags-store.ts'
import { presenceForBrief, presenceNews } from '../adapters/presence-store.ts'
import { readStdin } from '../adapters/stdin.ts'
import { AGY_AGENT, isAgySession } from '../core/agy.ts'
import { BRIEF_VERSION, brief, mcpBrief, waitReminder } from '../core/brief.ts'
import { calendarConfig } from '../core/calendar.ts'
import { decisionsConfig } from '../core/decisions.ts'
import { briefFlags, staleFlagsLine, withMasterFlags } from '../core/master-flags.ts'
import { boardMcpOff } from '../core/mcp-register.ts'
import { isNotice } from '../core/notices.ts'
import { secretsConfig, usableSinks } from '../core/secrets.ts'
import { todosConfig, todosNews } from '../core/todos.ts'
import { watchesConfig } from '../core/watches.ts'
import { threadsConfig } from '../core/work-threads.ts'

function emit(context: string | null): void {
  if (context) {
    console.log(
      JSON.stringify({
        injectSteps: [{ systemMessage: { systemMessage: context } }],
      }),
    )
  } else {
    console.log('{}')
  }
}

async function main(): Promise<void> {
  const raw = await readStdin()
  const input: unknown = JSON.parse(raw || '{}')
  if (!isRecord(input)) return emit(null)
  const event = input.hookEventName
  if (event !== 'SessionStart' && event !== 'PreInvocation') return emit(null)
  const sid = input.conversationId
  const pane = process.env.HERDR_PANE_ID
  if (!pane || typeof sid !== 'string' || !isAgySession(sid)) return emit(null)
  const own = process.env.ANTIGRAVITY_CONVERSATION_ID
  if (own && own !== sid) return emit(null)

  const agent = await agentGet(pane, 2000)
  if (agent?.kind !== AGY_AGENT) return emit(null)
  // If herdr already knows the pane's conversation id, only that root conversation may write its card.
  // Before herdr's PreInvocation hook reports for the first time (`agent.session === null`), allow
  // SessionStart or the very first invocation (invocationNum <= 1).
  const invNum = typeof input.invocationNum === 'number' ? input.invocationNum : 0
  if (agent.session !== null) {
    if (agent.session !== sid) return emit(null)
  } else if (event === 'PreInvocation' && invNum > 1) {
    return emit(null)
  } else if (event === 'SessionStart') {
    // herdr's own agy hook runs only on PreInvocation; report on SessionStart so woken/started
    // panes expose their conversation UUID immediately before the first prompt (#631).
    // Imported lazily so PreInvocation never loads the wake module tree.
    const transcript = typeof input.transcriptPath === 'string' && input.transcriptPath ? input.transcriptPath : null
    const { reportAgySession } = await import('../services/wake/agy.ts')
    await reportAgySession(pane, sid, transcript).catch(() => {})
  }

  const card = readCard(sid)
  const patch: CardPatch = {}
  const parentClaude = process.env.CLAUDE_CODE_SESSION_ID || false
  if (card?.agyParentClaude !== parentClaude) patch.agyParentClaude = parentClaude

  // PreInvocation runs before every model call in a turn (including after tool results).
  // Only treat it as a new user prompt when initialNumSteps advanced (or invocationNum <= 1 when absent).
  const steps = typeof input.initialNumSteps === 'number' ? input.initialNumSteps : null
  const isNewTurn =
    event === 'PreInvocation' &&
    (steps !== null ? card?.agyTurnSteps !== steps : typeof input.invocationNum !== 'number' || invNum <= 1)
  if (steps !== null && card?.agyTurnSteps !== steps) patch.agyTurnSteps = steps

  if (isNewTurn && (card?.pin || card?.ask)) {
    Object.assign(patch, { pin: '', pinAt: '', pinBusy: '' })
    if (!isNotice(input.lastUserInput)) Object.assign(patch, { ask: '', askSince: '' })
  }

  const cfg = loadConfig()
  // On a node (#775): the features its master has on; without `node` nothing is read and these are cfg's own.
  const flags = nodeMasterFlags(cfg)
  const gated = withMasterFlags(cfg, flags)
  const via = briefFlags(flags)
  const todos = todosConfig(gated.todos)
  let context: string | null = null
  if (event === 'SessionStart' || Number(card?.briefV ?? 0) < BRIEF_VERSION) {
    const presence = presenceForBrief(cfg) ?? via.presence
    const cwd =
      typeof input.cwd === 'string' && input.cwd
        ? input.cwd
        : Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string'
          ? input.workspacePaths[0]
          : ''
    const sinks = cfg.secrets === undefined ? [] : usableSinks(secretsConfig(cfg.secrets, { home: homedir() }))
    const calendar = calendarConfig(cfg.calendar) !== null || via.calendar
    const threads = threadsConfig(cfg.threads) ?? threadsConfig(via.threads)
    const watches = watchesConfig(gated.watches) !== null
    const decisions = decisionsConfig(gated.decisions)
    context = [
      brief(cfg, card, cwd, process.env, 'Antigravity', presence, todos, sinks, calendar, threads, watches, decisions),
      `Use \`board --session ${sid} <command>\` for the commands above if a tool shell does not inherit the herdr pane environment.`,
      // The board's MCP server, registered beside these hooks (#814), unless turned off.
      ...(boardMcpOff(readConfigFile()) ? [] : [mcpBrief()]),
    ].join('\n')
    const stale = presence && presence === via.presence ? staleFlagsLine(flags, Date.now()) : null
    if (stale) context = `${context}\n${stale}`
    Object.assign(patch, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
    if (presence) patch.presenceSeen = presence.since
    else if (card?.presenceSeen !== undefined) patch.presenceSeen = ''
  } else if (isNewTurn) {
    if (card?.wait) context = waitReminder(card)
    const news = presenceNews(card)
    if (news) {
      context = context ? `${context}\n${news.line}` : news.line
      patch.presenceSeen = news.seen
    }
  }
  const start = event === 'SessionStart'
  if ((start || isNewTurn) && (card?.todos !== undefined || card?.todosSeen !== undefined)) {
    const tasks = todos?.agents ? todosNews(start && card ? { ...card, todosSeen: '' } : card) : null
    if (tasks) {
      if (tasks.line) context = context ? `${context}\n${tasks.line}` : tasks.line
      patch.todosSeen = tasks.seen
    }
  }

  if (Object.keys(patch).length) writeCard(sid, patch)
  emit(context)
}

main().catch(() => emit(null)) // Always emit valid JSON so hooks never break an Antigravity turn.
