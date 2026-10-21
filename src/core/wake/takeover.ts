// The takeover's rules (#119, Migration): what the board's wake takes over from the separate
// herdr-wake plugin. Its config.json becomes the `wake` section (on Switch over…, Telegram set to
// Auto when the old router had tg-mcp's url and token, so it goes on routing; at wake's first start,
// which nobody asked for, the reaper and Telegram left off), its sleeping list of the last 7 days
// wake's session file (every entry the default folder's: the old router read ~/.claude only), its hooks come out of a
// settings.json (the entries its install-hooks.mjs recognises), and what it does not change is
// named: a wakeCommand whose program is not launch.claude's (call 25), and herdr key bindings that
// call its sleep and wake actions (call 26). Pure: the caller reads and writes the files.
import { OLD_WAKE_HOOK } from '../install-plan.ts'
import { claudeProgram } from '../launch/spawn-args.ts'
import { asWakeSessions, KEEP_GONE_MS, type WakeSessions } from './sessions.ts'

/** The old router's wakeCommand when its config.json had none: herdr's own resume. */
const DEFAULT_WAKE_COMMAND = 'claude --resume {session}'
/** The old router's workspace, which the board's wake does not reuse (its own is `Wake`). */
const OLD_WORKSPACE = 'tg-router'
/** herdr-wake's actions and the board's that do the same. */
const NEW_ACTION: Readonly<Record<string, string>> = {
  'herdr-wake.sleep': 'agent-board.sleep',
  'herdr-wake.wake': 'agent-board.wake',
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const commandOf = (v: unknown): string => {
  const hook = record(v)
  return typeof hook?.command === 'string' ? hook.command : ''
}

/**
 * Whether the old router routed Telegram: its config's url and token, each one it lacks from its
 * `server` MCP server in ~/.claude.json (`/mcp` taken off the url), both there (herdr-wake's
 * config.mjs resolveConfig).
 */
function hadTelegram(old: Record<string, unknown>, claudeJson: unknown): boolean {
  const server = typeof old.server === 'string' ? old.server : 'telegram'
  const mcp = record(record(record(claudeJson)?.mcpServers)?.[server])
  const mcpUrl = typeof mcp?.url === 'string' ? mcp.url.replace(/\/mcp\/?$/, '') : undefined
  const url = old.url ?? mcpUrl
  const authorization = old.authorization ?? record(mcp?.headers)?.Authorization
  return Boolean(url) && Boolean(authorization)
}

/**
 * The old config.json → the wake section: reaper (enabled, idleMinutes, exclude, maxPerRound), url,
 * authorization, server, port, wakeTimeoutSec, pollTimeoutSec, listSleepingDays, workspace only when
 * not 'tg-router'; telegram 'auto' when the old router had a url and token (its own or
 * ~/.claude.json's); keys it does not know kept as they are; wakeCommand dropped (every wake is
 * `board resume`). A config that is not an object is none: the old router's defaults. Without
 * `switches` (the takeover at wake's first start, which nobody asked for), the reaper and Telegram
 * are left off: the reaper's settings go over with it off, and Telegram is not set.
 */
export function takeOverConfig(
  old: unknown,
  claudeJson: unknown,
  { switches = true }: { switches?: boolean } = {},
): Record<string, unknown> {
  const o = record(old) ?? {}
  const { wakeCommand: _command, telegram: _telegram, workspace, reaper, ...rest } = o
  const reaperOf = record(reaper)
  return {
    ...rest,
    ...(reaper !== undefined && { reaper: !switches && reaperOf ? { ...reaperOf, enabled: false } : reaper }),
    ...(workspace !== undefined && workspace !== OLD_WORKSPACE && { workspace }),
    ...(switches && hadTelegram(o, claudeJson) && { telegram: 'auto' }),
  }
}

/**
 * The old sessions.json → wake's entries, each with the default folder as profileDir (the old
 * router knew ~/.claude only); only those the old router saw or put to sleep within KEEP_GONE_MS
 * (7 days) of `now`, as wake forgets a pane gone that long: an older one's pane id may be another
 * pane's by now. Entries that do not read as sessions are left out, a file that does not read is none.
 */
export function takeOverSessions(old: unknown, defaultDir: string, now: number): WakeSessions {
  const entries = Object.entries(asWakeSessions(old) ?? {})
    .filter(([, entry]) => now - Math.max(entry.seen_at, entry.slept_at ?? 0) <= KEEP_GONE_MS)
    .map(([pane, entry]) => {
      const { profileDir: _dir, profile: _id, ...rest } = entry
      return [pane, { ...rest, profileDir: defaultDir }] as const
    })
  return Object.fromEntries(entries)
}

/** A command line's program: its first word, or the first quoted one without its quotes. */
function programOf(command: string): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? ''
}

/** A program for comparing: its file name without .exe, .cmd, .bat or .ps1, lower case. */
const programName = (program: string): string =>
  (program.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()

/**
 * Call 25: the old wakeCommand's program against launch.claude's; null when they agree (the same
 * name, whatever its folder or extension) or the old one is the default.
 */
export function launcherNote(wakeCommand: unknown, launchClaude: unknown): { old: string; now: string } | null {
  if (typeof wakeCommand !== 'string') return null
  const command = wakeCommand.trim()
  if (!command || command === DEFAULT_WAKE_COMMAND) return null
  const old = programOf(command)
  const now = claudeProgram(launchClaude)
  return old && programName(old) !== programName(now) ? { old, now } : null
}

/**
 * settings.json without the separate herdr-wake plugin's hooks (the commands OLD_WAKE_HOOK
 * recognises, under any event): an entry left with no hooks goes, and an event left with no entry;
 * every other entry, event and key stays as it is. `removed` lists the commands taken out. The
 * input is not changed; settings that are not an object, or have none of those hooks, come back as
 * they are.
 */
export function withoutOldHooks(settings: unknown): { settings: unknown; removed: string[] } {
  const removed: string[] = []
  const hooks = record(record(settings)?.hooks)
  if (!hooks) return { settings, removed }
  const next: Record<string, unknown> = {}
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      next[event] = list
      continue
    }
    let touched = false
    const kept: unknown[] = []
    for (const entry of list) {
      const e = record(entry)
      if (!e || !Array.isArray(e.hooks)) {
        kept.push(entry)
        continue
      }
      const left = e.hooks.filter((hook: unknown) => {
        const command = commandOf(hook)
        if (!OLD_WAKE_HOOK.test(command)) return true
        removed.push(command)
        return false
      })
      if (left.length === e.hooks.length) kept.push(entry)
      else {
        touched = true
        if (left.length) kept.push({ ...e, hooks: left })
      }
    }
    if (!touched) next[event] = list
    else if (kept.length) next[event] = kept
  }
  if (!removed.length) return { settings, removed }
  return { settings: { ...record(settings), hooks: next }, removed }
}

/**
 * Call 26: herdr key bindings ([[keys.command]] tables whose command is "herdr-wake.sleep" or
 * "herdr-wake.wake", read as board doctor reads the board's key) with their new names; `key` is ''
 * when the binding has none it can read.
 */
export function oldActionBindings(configToml: string | null): { key: string; old: string; now: string }[] {
  const found: { key: string; old: string; now: string }[] = []
  for (const block of String(configToml ?? '')
    .split(/^\s*\[\[keys\.command\]\]\s*$/m)
    .slice(1)) {
    const body = block.split(/^\s*\[/m)[0] ?? ''
    const old = /^\s*command\s*=\s*["'](herdr-wake\.(?:sleep|wake))["']/m.exec(body)?.[1]
    const now = old === undefined ? undefined : NEW_ACTION[old]
    if (old === undefined || now === undefined) continue
    found.push({ key: /^\s*key\s*=\s*["']([^"']+)["']/m.exec(body)?.[1] ?? '', old, now })
  }
  return found
}
