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
// folder), so a name two profiles use never wakes the other one's (decision 9). With more than one
// profile shown (#251), the other shown profiles' sessions come after: ListAgents lists them, and
// SendMessage to a name that only they have (not the caller's profile, running or asleep) is
// delivered by the board as a reminder from the caller, the native call denied with why. With one
// shown, both go as before. config.json's kill switch is read first: wake off, or a config.json
// that does not parse, and wake is asked nothing. Wake not running or not answering, or anything
// else amiss: silent, and the tool runs as it would.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { loadProfiles } from '../adapters/profiles.ts'
import { readStdin } from '../adapters/stdin.ts'
import { sameDir } from '../core/launch/names.ts'
import { type Profile, profileForDir, resolveProfileDir, shownProfiles } from '../core/profiles.ts'
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

/** The profiles the board shows, besides the caller's, when more than one is shown; null with one (#251). */
function otherProfiles(): { list: Profile[]; others: Profile[]; ownDir: string } | null {
  const list = loadProfiles()
  const shown = shownProfiles(list)
  if (shown.length < 2) return null
  const ownDir = resolveProfileDir(process.env.CLAUDE_CONFIG_DIR, homedir())
  return { list, others: shown.filter(p => !sameDir(p.dir, ownDir)), ownDir }
}

/** The entries of `list` in profile `p` (no profile: the default folder's, as ownSleepers reads it). */
const inProfile = (list: Entry[], p: Profile): Entry[] => ownSleepers(list, { configDir: p.dir, home: homedir() })

/** ListAgents: the other shown profiles' running and sleeping sessions, each with its profile; null for none. */
function othersContext(sleeping: Entry[], running: Entry[] | null, others: Profile[], days: number): string | null {
  const rows: string[] = []
  for (const p of others) {
    for (const s of inProfile(running ?? [], p))
      rows.push(`  ${s.name}  ·  profile ${p.title}  ·  ${String(s.status)} ${ago(s.since)}`)
    const recent = inProfile(sleeping, p)
      .filter(s => Date.now() - sleptAt(s) < days * 86_400_000)
      .sort((a, b) => sleptAt(b) - sleptAt(a))
      .slice(0, LIST_MAX)
    for (const s of recent) rows.push(`  ${s.name}  ·  profile ${p.title}  ·  asleep ${ago(s.slept_at)}`)
  }
  if (!rows.length) return null
  return (
    `Sessions of the other Claude profiles on this machine (not listed above: Claude Code knows only this ` +
    `profile's). SendMessage to one by name goes through the board: it types the message in once the session ` +
    `is free, waking it first if it sleeps, and the reply comes back the same way. A name this profile has too ` +
    `goes to this profile's session.\n${rows.join('\n')}`
  )
}

const deny = (reason: string): void =>
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  )

/** A session of another profile SendMessage's name fits. */
interface Fit {
  name: string
  profile: Profile
  pane?: string
  cwd?: string
}

/**
 * SendMessage to `to` (lower case; `ref`, the hex after it, picks a session by the start of its id
 * when it has 8 or more), not a session of the caller's profile: when exactly one session of another
 * shown profile has the name, the board takes it (a reminder due now, typed in once the session is
 * free, signed with the caller's Claude name and a ref to answer to) and the native call is denied
 * saying so; two or more are refused, listed; none: left to Claude Code. The caller's own running
 * sessions are Claude Code's, as its sleepers were the wake's. A running one counts only when herdr
 * runs it (GET /awake), so the board can type into it; a message that is no text is Claude Code's,
 * and one longer than a reminder carries is refused, not cut.
 */
async function sendElsewhere(
  to: string,
  ref: string,
  input: Record<string, unknown>,
  sleeping: Entry[],
  port: number,
  raw: Record<string, unknown> | null,
): Promise<void> {
  const message = isRecord(input.tool_input) ? input.tool_input.message : undefined
  if (typeof message !== 'string') return
  const set = otherProfiles()
  if (!set) return
  const { createClaudeHome } = await import('../adapters/claude-home.ts')
  const live = (dir: string) => [...createClaudeHome(dir).liveSessions().values()]
  const byRef = (id: string): boolean => ref.length < 8 || id.toLowerCase().startsWith(ref)
  const own = live(set.ownDir)
  if (own.some(s => s.name?.toLowerCase() === to && byRef(s.sessionId))) return
  const fits = new Map<string, Fit>()
  let awake: Entry[] | null | undefined
  for (const profile of set.others) {
    for (const s of live(profile.dir)) {
      if (s.name?.toLowerCase() !== to || !byRef(s.sessionId) || fits.has(s.sessionId)) continue
      // Only a session herdr runs gets typed into: in /awake, in its profile, by its name.
      awake ??= entries(await api(port, '/awake', null, 3000).catch(() => null))
      const panes = inProfile(awake ?? [], profile).filter(a => a.name.toLowerCase() === to)
      if (!panes.length) continue
      const pane = panes.length === 1 && typeof panes[0]?.pane === 'string' ? panes[0].pane : ''
      fits.set(s.sessionId, { name: s.name, profile, ...(pane && { pane }), ...(s.cwd && { cwd: s.cwd }) })
    }
    for (const s of inProfile(sleeping, profile)) {
      const id = typeof s.session === 'string' ? s.session : ''
      if (s.name.toLowerCase() !== to || !id || !byRef(id) || fits.has(id)) continue
      fits.set(id, {
        name: s.name,
        profile,
        ...(typeof s.pane === 'string' && s.pane && { pane: s.pane }),
        ...(typeof s.cwd === 'string' && s.cwd && { cwd: s.cwd }),
      })
    }
  }
  if (!fits.size) return
  const [{ addEntry, schedulerRuns }, { cleanName, cleanText, MAX_TEXT }] = await Promise.all([
    import('../adapters/schedule-store.ts'),
    import('../core/schedule-rules.ts'),
  ])
  const text = cleanText(message, Number.POSITIVE_INFINITY)
  if (!text.trim()) return
  if (text.length > MAX_TEXT)
    return deny(
      `Not sent: ${text.length} characters, the board carries ${MAX_TEXT}; send it in parts, or write it to a ` +
        `file and send the path.`,
    )
  if (fits.size > 1) {
    const listed = [...fits].map(([key, f]) => `${f.name} [${key.slice(0, 8)}] in profile ${f.profile.title}`)
    return deny(
      `Not sent: "${to}" fits more than one session of the other profiles (${listed.join(', ')}), and none of ` +
        `this one. Send it to one of them by its name with its ref, as listed.`,
    )
  }
  const first = [...fits][0]
  if (!first) return
  const [key, f] = first
  const sid = String(input.session_id ?? '') || process.env.CLAUDE_CODE_SESSION_ID || ''
  if (!sid) return
  // Signed with the caller's Claude name, as `board remind` does: the name SendMessage knows it by
  // (its card's may be another). A reply needs that name and a profile the other side shows.
  const name = own.find(s => s.sessionId === sid)?.name?.trim() ?? ''
  const ownProfile = profileForDir(set.list, set.ownDir)
  const replyTo = name && ownProfile && !ownProfile.hidden ? cleanText(`${name} [${sid.slice(0, 8)}]`) : ''
  const now = Date.now()
  try {
    addEntry({
      key,
      name: f.name,
      ...(f.pane && { pane: f.pane }),
      ...(f.cwd && { cwd: f.cwd }),
      text,
      at: now,
      next: now,
      idle: true,
      by: 'agent',
      from: { key: sid, name },
      fromProfile: cleanName(ownProfile?.title ?? set.ownDir),
      replyTo,
    })
  } catch (err) {
    return deny(
      `Not sent: ${f.name} is a session of profile ${f.profile.title}, and the board could not take the message: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // As `board remind` says it: no board runs the schedule now, so nothing is typed in until one does.
  const board = async (): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`http://127.0.0.1:${Number(raw?.port) || 12422}/api/board`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json()
    return isRecord(body) ? body : null
  }
  const down = (await schedulerRuns(raw?.web !== false, board))
    ? ''
    : ' Note: no board with the scheduler is running now; it goes out once one runs.'
  const reply = replyTo
    ? `The reply comes back the same way, as a board reminder from ${f.name}.`
    : `No reply comes back this way: ${name ? 'this profile is not shown on the board' : 'this session has no name'}.`
  deny(
    `Queued for ${f.name} in profile ${f.profile.title} through the board (Claude Code reaches only this ` +
      `profile's sessions, so it did not send it): the board types it in as a board reminder from ` +
      `${name || sid.slice(0, 8)} once ${f.name} is free, waking it first if it sleeps.${down} Do not send it ` +
      `again. ${reply}`,
  )
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
    const named = String((isRecord(input.tool_input) ? input.tool_input.to : undefined) ?? '')
    const ref = /\[([0-9a-f]+)\]\s*$/i.exec(named)?.[1]?.toLowerCase() ?? ''
    const to = named
      .replace(/\s*\[[0-9a-f]+\]\s*$/i, '')
      .trim()
      .toLowerCase()
    if (!to) return
    const sleeping = entries(await api(settings.port, '/sleeping', null, 3000))
    const target = sleeping && own(sleeping).find(s => s.name.toLowerCase() === to)
    if (sleeping && !target) return sendElsewhere(to, ref, input, sleeping, settings.port, raw)
    // By its session id: its name may be another profile's sleeper's too.
    const id = target && [target.session, target.pane].find(v => typeof v === 'string' && v !== '')
    if (!target || !id) return
    const r = await api(settings.port, '/wake', { target: id }, 170_000)
    if (isRecord(r) && !r.ok)
      deny(`${target.name} is asleep (the board's wake) and could not be woken: ${String(r.error)}`)
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
  const ownPart = listContext(own(sleeping), awake && own(awake), settings.port, settings.listSleepingDays)
  // The other profiles' part on its own: whatever goes wrong there, this profile's still shows.
  let others: string | null = null
  try {
    const set = otherProfiles()
    others = set && othersContext(sleeping, awake, set.others, settings.listSleepingDays)
  } catch {}
  const context = [ownPart, others].filter(Boolean).join('\n\n')
  if (context)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }))
}

// Wake not running or not answering, or input that does not parse: leave the tool call alone.
main().catch(() => {})
