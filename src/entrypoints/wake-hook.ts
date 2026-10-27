// The Claude Code hooks of the board's wake (#119), written into every shown profile while wake is
// on:
//
//   bun src/entrypoints/wake-hook.ts pre-send    PreToolUse on SendMessage: if the recipient is one
//                                                of this profile's sleeping sessions, wake it first
//   bun src/entrypoints/wake-hook.ts post-list   PostToolUse on ListAgents: this profile's sleeping
//                                                sessions too, and how long each running one has
//                                                been idle or busy
//
// Ported from herdr-wake's hook.mjs, its texts word for word but the name ("the board's wake").
// Each keeps only the sessions of its caller's profile (CLAUDE_CONFIG_DIR; unset: the default
// folder), so a name two profiles use never wakes the other one's, and a name only another
// profile has is left to Claude Code (decision 9). config.json's kill switch is read first: wake
// off, or a config.json that does not parse, and wake is asked nothing. Wake not running or not
// answering, or anything else amiss: silent, and the tool runs as it would.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { readStdin } from '../adapters/stdin.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { ownSleepers, type WakeProfile } from '../core/wake/rules.ts'

/** ListAgents shows the sessions that fell asleep in the last listSleepingDays, at most this many; the rest as a count. */
const LIST_MAX = 15

/** A session in wake's answers: its fields as they came, its name, its profile when it has one. */
interface Entry {
  [field: string]: unknown
  name: string
  profile?: WakeProfile
}

/** The sessions of an answer that have a name; null when it is no list. A profile without a folder is kept as one, which no caller has. */
function entries(answer: unknown): Entry[] | null {
  if (!Array.isArray(answer)) return null
  const list: Entry[] = []
  for (const e of answer) {
    if (!isRecord(e) || typeof e.name !== 'string') continue
    const { profile, ...rest } = e
    const dir = isRecord(profile) && typeof profile.dir === 'string' ? profile.dir : ''
    list.push({ ...rest, name: e.name, ...(profile === undefined ? {} : { profile: { dir } }) })
  }
  return list
}

/** Wake's answer to a GET (no body) or a POST, whatever its status. */
async function api(port: number, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res.json()
}

function ago(iso: unknown): string {
  const min = Math.round((Date.now() - Date.parse(String(iso))) / 60_000)
  return min < 90 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`
}

// Why the reaper leaves a running session up; busy and shell need no words.
const KEPT: Record<string, string> = {
  excluded: 'never sleeps (excluded)',
  'has scheduled jobs': 'stays awake: has scheduled jobs',
  focused: 'stays awake while focused',
  'herdr says blocked': 'waiting for an answer in its terminal',
}

function activity(s: Entry): string {
  const kept = typeof s.kept === 'string' && Object.hasOwn(KEPT, s.kept) ? KEPT[s.kept] : undefined
  const when =
    s.sleeps_in_min === 0
      ? 'goes to sleep within a minute'
      : s.sleeps_in_min != null
        ? `sleeps in ${String(s.sleeps_in_min)} min`
        : kept
  return [s.name, `${String(s.status)} ${ago(s.since)}`, when].filter(Boolean).join('  ·  ')
}

/** The time a session fell asleep, in ms. */
const sleptAt = (s: Entry): number => Date.parse(String(s.slept_at))

/** ListAgents: what Claude is told besides the tool's own list; null for nothing. */
function listContext(list: Entry[], running: Entry[] | null, port: number, days: number): string | null {
  const parts: string[] = []
  if (running?.length) {
    parts.push(
      `Running sessions on this machine, how long since their status last changed ("started" above is when ` +
        `the process started or was woken, not the last activity):\n` +
        running.map(s => `  ${activity(s)}`).join('\n'),
    )
  }
  if (list.length) {
    const recent = list
      .filter(s => Date.now() - sleptAt(s) < days * 86_400_000)
      .sort((a, b) => sleptAt(b) - sleptAt(a))
      .slice(0, LIST_MAX)
    const rows = recent.map(
      s =>
        `  ${s.name}  ·  workspace ${String(s.workspace)}  ·  ${s.exited ? 'exited by the user' : 'put to sleep'} ${ago(s.slept_at)} ago`,
    )
    const rest = list.length - recent.length
    if (rest) {
      rows.push(
        `  ... and ${rest} asleep longer, not shown (all: http://127.0.0.1:${port}/sleeping); ` +
          `SendMessage by name wakes them too`,
      )
    }
    parts.push(
      `Sleeping sessions on this machine (not listed above): put to sleep by the board's wake after they sat idle, or ` +
        `exited by the user; they wake in their pane, or in a new tab when wake closed it. ` +
        `SendMessage to one by name wakes it first (takes about 10 to 30 seconds), then delivers. ` +
        `A sleeping session is a normal target: do not reroute its work or call it gone because it sleeps; ` +
        `once woken it is the same session (id, name, transcript).\n${rows.join('\n')}`,
    )
  }
  return parts.length ? parts.join('\n\n') : null
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode !== 'pre-send' && mode !== 'post-list') return
  // The kill switch first: off, or a config.json that does not parse, and wake is asked nothing.
  const raw = readConfigFile()
  if (!wakeSwitch({ exists: existsSync(configFile()), raw })) return
  const settings = wakeConfig(raw?.wake)
  const input: unknown = JSON.parse((await readStdin()) || '{}')
  if (!isRecord(input)) return
  const own = (list: Entry[]): Entry[] =>
    ownSleepers(list, { configDir: process.env.CLAUDE_CONFIG_DIR, home: homedir() })

  if (mode === 'pre-send') {
    const to = String((isRecord(input.tool_input) ? input.tool_input.to : undefined) ?? '')
      .replace(/\s*\[[0-9a-f]+\]\s*$/i, '')
      .trim()
      .toLowerCase()
    if (!to) return
    const sleeping = entries(await api(settings.port, '/sleeping', null, 3000))
    const target = sleeping && own(sleeping).find(s => s.name.toLowerCase() === to)
    // By its session id: its name may be another profile's sleeper's too.
    const id = target && [target.session, target.pane].find(v => typeof v === 'string' && v !== '')
    if (!target || !id) return
    const r = await api(settings.port, '/wake', { target: id }, 170_000)
    if (isRecord(r) && !r.ok) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${target.name} is asleep (the board's wake) and could not be woken: ${String(r.error)}`,
          },
        }),
      )
    }
    return
  }

  // /awake is newer than /sleeping: an older router answers 404, then only the sleepers show.
  const [list, running] = await Promise.all([
    api(settings.port, '/sleeping', null, 3000),
    api(settings.port, '/awake', null, 3000).catch(() => null),
  ])
  const sleeping = entries(list)
  if (!sleeping) return
  const awake = entries(running)
  const context = listContext(own(sleeping), awake && own(awake), settings.port, settings.listSleepingDays)
  if (context)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }))
}

// Wake not running or not answering, or input that does not parse: leave the tool call alone.
main().catch(() => {})
