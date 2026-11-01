// What a session is told about the board (see entrypoints/hook.ts and codex-hook.ts).
import { categoryFor } from './categories.ts'
import { languageName } from './lang.ts'
import { type Presence, presenceBrief } from './presence.ts'
import { type TodosConfig, todosBrief } from './todos.ts'
import type { Card, Config } from './types.ts'

// Bump when the brief says something new: every running session gets it again on its next prompt.
export const BRIEF_VERSION = 5

type Env = Record<string, string | undefined>

/**
 * Where the session runs, when herdr is its host (herdr puts the pane's ids into its environment),
 * and where to read how to work in it. Nothing outside herdr.
 */
export function herdrLine(env: Env = process.env, agent: 'Claude' | 'Codex' = 'Claude'): string {
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID) return ''
  const where = [
    env.HERDR_TAB_ID && `tab ${env.HERDR_TAB_ID}`,
    env.HERDR_WORKSPACE_ID && `workspace ${env.HERDR_WORKSPACE_ID}`,
  ]
    .filter(Boolean)
    .join(', ')
  const help =
    agent === 'Codex'
      ? 'Starting or messaging other sessions, a pane for a server or a login: read `herdr --skill` for the CLI instructions.'
      : 'Starting or messaging other sessions, doing something later, restarting itself (a dropped MCP server, changed settings, hooks or skills), a pane for a server or a login: see the herdr-agents skill.'
  return `This session runs in herdr, in pane ${env.HERDR_PANE_ID}${where ? ` (${where})` : ''}. ${help}`
}

export function brief(
  cfg: Pick<Config, 'categories'>,
  card: Card | null | undefined,
  cwd: string,
  env: Env = process.env,
  agent: 'Claude' | 'Codex' = 'Claude',
  /** The user's presence (core/presence.ts), only where config.json turned it on; null: nothing said. */
  presence: Presence | null = null,
  /** Tasks (#202, core/todos.ts), only where config.json turned them on; agents hear of them only with agents on. */
  todos: TodosConfig | null = null,
  /** The secret sinks config.json defines (#273); agents hear of `board secret` only where there are any. */
  sinks: readonly string[] = [],
  /** Of those, the board's own store's (kind store): where it is the only one, the store's line. */
  stores: readonly string[] = [],
): string {
  const cat = card?.category
  const guess = categoryFor(cfg, cwd)
  const now = cat ? `${cat}` : guess ? `${guess} (guessed from the folder, set it if wrong)` : 'not set, set it now'
  const known = cfg.categories.map(c => `${c.id} (${c.title})`).join(', ')
  const state = [
    card?.doing && `doing "${card.doing}"`,
    card?.wait && `waiting "${card.wait}"`,
    card?.ask && `asks the user "${card.ask}"`,
  ]
    .filter(Boolean)
    .join(', ')
  return [
    `[agent-board] The user watches every ${agent} session on a kanban board in herdr: lanes by category; columns working, needs the user, waiting on someone else, done, idle.`,
    "Working, done and terminal dialogs are detected automatically. Keep the rest of this session's card current with the `board` shell command (Bash or PowerShell; it prints one line; no need to tell the user):",
    `- board cat <id>: this session's lane. Now: ${now}. Known: ${known}. For a client that has none yet: board cat <new-id> "<Title>" adds it.`,
    '- board doing "<3-8 words>": when you start a distinct task.',
    '- board ask "<the question, short>": before ending a turn that needs the user\'s answer or decision (approve a draft, pick an option, give data). Puts the card under "needs the user"; cleared by itself when the user replies.',
    '- board wait "<who/what>": before ending a turn blocked on something outside this chat (client reply, CI, another session, a date). The card stays in "waiting" until you run doing or done.',
    '- board done ["<result>"]: task finished; clears doing, wait and ask.',
    '- board remind <when> "<text>": at that time the board types "[board reminder] <text>" into this session as a prompt, waking it if it sleeps; on time, so a working session gets it queued into its turn (add --idle to wait until it is free, for work that needs a fresh turn rather than a time). when: in 30m, in 2h, at 15:30, tomorrow 9:00, fri 17:00, 2026-10-20 14:00 (local time). board every "<cron, 5 fields>" "<text>" repeats it (runs at least 5 minutes apart); board schedule lists this session\'s entries, board unschedule <id> removes one. Write the text as an instruction to yourself.',
    agent === 'Claude' &&
      "  More reliable than CronCreate or ScheduleWakeup: those live in this Claude process and die when the idle session is put to sleep; the board's entries survive sleep and restarts. Use it for anything due later than a few minutes.",
    agent === 'Claude' && todos?.agents && todosBrief(),
    agent === 'Claude' && sinks.length > 0 && secretsBrief(sinks, stores),
    `Card texts in ${languageName()}, short. Call it only when the state changes, not every turn.${state ? ` Card now: ${state}.` : ''}`,
    presence && presenceBrief(presence),
    herdrLine(env, agent),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * How an agent asks the owner for a secret it must never see (#273), with the sinks there are;
 * `stores`, those of them that are the board's own store. With the store the only one (the owner
 * defined no sink), how it reads the value once kept.
 */
export function secretsBrief(sinks: readonly string[], stores: readonly string[] = []): string {
  if (sinks.length === 1 && stores.length === 1 && sinks[0] === stores[0])
    return `- board secret request --title "<what for>" --field <NAME>[:shown]... [--global | --profile <id>]: a token, a password or a key you need but must not be handed in the chat. The owner types it into a form on the board and the board keeps it in its encrypted store as the variable NAME for this session (--profile <id>: that profile's sessions; --global: every session); you get back only ok, declined or expired (run it in the background: it waits). Then board secret get <NAME> prints it for this session (a new or restarted session has it in its environment). Never ask for a secret in the chat or with a script of your own.`
  const store = stores.length
    ? ` ${stores.join(', ')}: the board's own store, --field <NAME> a variable for this session (--global, --profile <id>), read with board secret get <NAME>.`
    : ''
  return `- board secret request --title "<what for>" --sink <id> [--field <name>[:shown]]... [--param <name>=<value>]...: a token, a password or keys you must never see. The owner types them into a form on the board and the board writes them where the sink says; you get back only ok, declined or expired (run it in the background: it waits). Never ask for a secret in the chat or with a script of your own. Sinks: ${sinks.join(', ')} (board secret sinks says what each takes).${store}`
}

export function waitReminder(card: Pick<Card, 'wait'>): string {
  return `[agent-board] This session's card says it waits for: "${card.wait}". If this prompt resolves that, update the card (board doing / done / wait).`
}
