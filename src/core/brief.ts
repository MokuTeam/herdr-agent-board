// What a session is told about the board (see entrypoints/hook.ts and codex-hook.ts).
import { categoryFor } from './categories.ts'
import { languageName } from './lang.ts'
import { type Presence, presenceBrief } from './presence.ts'
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
    `Card texts in ${languageName()}, short. Call it only when the state changes, not every turn.${state ? ` Card now: ${state}.` : ''}`,
    presence && presenceBrief(presence),
    herdrLine(env, agent),
  ]
    .filter(Boolean)
    .join('\n')
}

export function waitReminder(card: Pick<Card, 'wait'>): string {
  return `[agent-board] This session's card says it waits for: "${card.wait}". If this prompt resolves that, update the card (board doing / done / wait).`
}
