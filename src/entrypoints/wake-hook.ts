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
// shown, both go as before. With `nodes` in config.json (#619), the sessions on the board's nodes
// come last: ListAgents lists them from the board's payload, and SendMessage to a name only a node's
// session has (nothing on this computer has it) is queued by the board for its key, which the
// scheduler sends through the node. Without `nodes` the board is asked nothing. On a node
// (config.json `node`, #639) both go the other way, up the node's link to the master
// (services/node/uplink.ts): ListAgents lists the master's sessions as its `board agents` gives them,
// and SendMessage to a name nothing on this computer has is the master's `board send` from this
// session. Without `node` no call goes up. config.json's kill switch is read first: wake off, or a
// config.json that does not parse, and wake is asked nothing.
// Wake not running or not answering, or anything else amiss: silent, and the tool runs as it would.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agyConfigDir } from '../adapters/agy-hooks.ts'
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

/** The Claude session id of MokuPilot's day running now (#331), null for none. */
async function daySession(): Promise<string | null> {
  try {
    const { runningDay } = await import('../adapters/mokupilot-day.ts')
    return runningDay()?.session ?? null
  } catch {
    return null
  }
}

/** A node's call to its master (#639): `POST /api/node/call` on this computer's board, as `board send` and `board agents` make it. */
async function nodeCall(
  raw: Record<string, unknown> | null,
  body: { cmd: string; argv: string[]; session: string },
  timeoutMs: number,
): Promise<Record<string, unknown> | 'late' | null> {
  const started = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${Number(raw?.port) || 12422}/api/node/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ ...body, lane: null, files: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const answer: unknown = res.ok ? await res.json() : null
    // The node's board says "unreachable" at once when no master listens, and after its wait
    // (services/node/uplink.ts READ_MS) when one took the call and did not answer: that one may have run it.
    if (isRecord(answer) && answer.state === 'unreachable' && Date.now() - started > TAKEN_MS) return 'late'
    return isRecord(answer) ? answer : null
  } catch (err) {
    // Taken and not answered in time: the master may have run it all the same.
    return err instanceof Error && err.name === 'TimeoutError' ? 'late' : null
  }
}

/** What a master sends, as it goes into a line for an agent: no control characters (names as #619 shows them). */
const printable = (s: string): string => s.replace(/\p{Cc}+/gu, ' ')

/** A result's lines as the master sent them, printable. */
const linesOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string').map(printable) : []

/**
 * How long ListAgents waits for the master's list (its hook has 10 s in all); SendMessage for its
 * `send`, past the node board's own wait; an "unreachable" that came later than TAKEN_MS was taken.
 */
const MASTER_LIST_MS = 5_000
const MASTER_SEND_MS = 15_000
const TAKEN_MS = 1_500
/** The most characters of the master's line a deny repeats. */
const MASTER_LINE_MAX = 400

/** The sessions the master lets this node session reach (its `board agents --json`, one view a line or all in one), or null. */
async function masterViews(
  raw: Record<string, unknown> | null,
  sid: string,
): Promise<Record<string, unknown>[] | null> {
  const answer = await nodeCall(raw, { cmd: 'agents', argv: ['--json'], session: sid }, MASTER_LIST_MS)
  if (!isRecord(answer) || answer.state !== 'answered' || answer.code !== 0) return null
  try {
    const views: unknown = JSON.parse(linesOf(answer.out).join('\n'))
    return Array.isArray(views) ? views.filter(isRecord) : null
  } catch {
    return null
  }
}

/** ListAgents on a node (#639): the master's sessions, as its `board agents` lists them for this session; null for none. */
async function masterContext(
  raw: Record<string, unknown> | null,
  input: Record<string, unknown>,
): Promise<string | null> {
  const sid = String(input.session_id ?? '') || process.env.CLAUDE_CODE_SESSION_ID || ''
  if (!sid) return null
  const views = await masterViews(raw, sid)
  if (!views) return null
  // The master's own computer's (no device): this node's are listed above, another node's never come.
  const theirs = views.filter(v => isRecord(v) && v.device === null && typeof v.label === 'string' && v.self !== true)
  const plain = (v: unknown): string => printable(String(v)).slice(0, 120)
  const row = (v: Record<string, unknown>): string =>
    `  ${plain(v.label)}${typeof v.agent === 'string' && v.agent !== 'claude' ? `  ·  ${plain(v.agent)}` : ''}  ·  ${plain(v.status)}`
  const live = theirs.filter(v => v.sleeping !== true)
  const asleep = theirs.filter(v => v.sleeping === true)
  const rows = [...live, ...asleep.slice(0, LIST_MAX)].map(row)
  if (asleep.length > LIST_MAX)
    rows.push(
      `  ... and ${asleep.length - LIST_MAX} more asleep there, not shown (board agents lists all); SendMessage by name reaches them too`,
    )
  if (!rows.length) return null
  return (
    `Sessions on the board's main computer (this one is its node; not listed above: Claude Code knows only this ` +
    `computer's). SendMessage to one by name goes through the board: it types the message in once the session is ` +
    `free, waking it first if it sleeps, and the reply comes back as a board reminder. Two with one name: add the ` +
    `ref in brackets, as listed. \`board send "<name>" "<text>"\` does the same from a shell.\n${rows.join('\n')}`
  )
}

/**
 * SendMessage on a node (#639) to a name nothing on this computer has: the master's `board send` from
 * this session, which queues it for the master's session of that name (signed with this one's key,
 * so the answer comes back here). No such session there, or the master away: Claude Code's own
 * answer, as before. Asked in two steps, `agents` then `send`, so only a send for a session the master
 * has can be left unanswered and so denied as maybe queued.
 */
async function sendToMaster(named: string, message: string, sid: string, raw: Record<string, unknown> | null) {
  // First the read, which has no side effects: a master away or slow, or a name it has no session
  // for (a teammate of this process), is Claude Code's at once. Only a name it has is sent.
  const views = await masterViews(raw, sid)
  if (!views) return
  const { matching, targetsOf } = await import('../core/agent-send.ts')
  const known = targetsOf(
    views.map(v => ({ key: v.key, name: v.name, device: v.device, sleeping: v.sleeping, day: true })),
  )
  if (!matching(known, named).length) return
  const answer = await nodeCall(raw, { cmd: 'send', argv: [named, message], session: sid }, MASTER_SEND_MS)
  if (answer === 'late')
    return deny(
      `The board's main computer did not answer in time: it may have queued the message for "${named.trim()}" all ` +
        `the same. Check before sending it again (board agents lists who is there).`,
    )
  if (!isRecord(answer) || answer.state !== 'answered') return
  const out = linesOf(answer.out).join(' ').slice(0, MASTER_LINE_MAX)
  const why = linesOf(answer.err).join(' ').slice(0, MASTER_LINE_MAX)
  if (answer.code === 0)
    return deny(
      `Queued through the board on its main computer (Claude Code reaches only this computer's sessions, so it ` +
        `did not send it): ${out.replace(/^ok · /, '')}. Do not send it again.`,
    )
  // Said only when the master has a session of that name and did not send to it (core/agent-send.ts
  // planSend): several fit, the text does not, the schedule did not take it. Anything else (no such
  // session there, a master that does not take `send` from a node, a call the node's board refused)
  // is Claude Code's, as before: the name may be a teammate of this process.
  if (/fits more than one session \(|^not sent: |^the board could not take the message/.test(why))
    deny(`Not sent: ${why.replace(/^not sent: /, '')}`)
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
 * Whether it settled the call (true: queued, refused, or left to Claude Code as this profile's);
 * false when no session of another profile has the name, so a node's may (#619).
 *
 * SendMessage to `to` (lower case; `ref`, the hex after it, picks a session by the start of its id
 * when it has 8 or more), not a session of the caller's profile: when exactly one session of another
 * shown profile has the name, the board takes it (a reminder due now, typed in once the session is
 * free, signed with the caller's Claude name and a ref to answer to) and the native call is denied
 * saying so; two or more are refused, listed; none: left to Claude Code. The caller's own running
 * sessions are Claude Code's, as its sleepers were the wake's. A running one counts only when herdr
 * runs it (GET /awake), so the board can type into it, or when it is MokuPilot's day session (#331),
 * whose day's inbox the board writes to; a message that is no text is Claude Code's,
 * and one longer than a reminder carries is refused, not cut.
 */
async function sendElsewhere(
  to: string,
  ref: string,
  input: Record<string, unknown>,
  sleeping: Entry[],
  port: number,
  raw: Record<string, unknown> | null,
): Promise<boolean> {
  const message = isRecord(input.tool_input) ? input.tool_input.message : undefined
  if (typeof message !== 'string') return true
  const set = otherProfiles()
  if (!set) return false
  const { createClaudeHome } = await import('../adapters/claude-home.ts')
  const live = (dir: string) => [...createClaudeHome(dir).liveSessions().values()]
  const byRef = (id: string): boolean => ref.length < 8 || id.toLowerCase().startsWith(ref)
  const own = live(set.ownDir)
  if (own.some(s => s.name?.toLowerCase() === to && byRef(s.sessionId))) return true
  const fits = new Map<string, Fit>()
  let awake: Entry[] | null | undefined
  let day: string | null | undefined
  for (const profile of set.others) {
    for (const s of live(profile.dir)) {
      if (s.name?.toLowerCase() !== to || !byRef(s.sessionId) || fits.has(s.sessionId)) continue
      // Only a session herdr runs gets typed into: in /awake, in its profile, by its name.
      awake ??= entries(await api(port, '/awake', null, 3000).catch(() => null))
      const panes = inProfile(awake ?? [], profile).filter(a => a.name.toLowerCase() === to)
      if (!panes.length) {
        // Or MokuPilot's day session (#331), which herdr does not name: the board puts it in its inbox.
        day ??= raw?.mokupilot === false || !existsSync(join(homedir(), '.meeting-copilot')) ? null : await daySession()
        if (day === s.sessionId) fits.set(s.sessionId, { name: s.name, profile, ...(s.cwd && { cwd: s.cwd }) })
        continue
      }
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
  if (!fits.size) return false
  await queueElsewhere(fits, to, message, input, raw, set, own)
  return true
}

/** sendElsewhere's one fit queued through the board, or the deny that says why not. */
async function queueElsewhere(
  fits: Map<string, Fit>,
  to: string,
  message: string,
  input: Record<string, unknown>,
  raw: Record<string, unknown> | null,
  set: NonNullable<ReturnType<typeof otherProfiles>>,
  own: { sessionId: string; name?: string }[],
): Promise<void> {
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

/** Whether this computer may host non-Claude agent sessions (`agy`, `pi`, `codex`, #628). */
function hasLocalOtherAgents(raw: Record<string, unknown> | null): boolean {
  if (
    isRecord(raw?.launch) &&
    (raw.launch.agy !== undefined || raw.launch.pi !== undefined || raw.launch.codex !== undefined)
  )
    return true
  if (typeof raw?.codexHome === 'string' && raw.codexHome.trim() !== '') return true
  // The path of adapters/agy-home.ts defaultAgyRoot, inlined: that module pulls in bun:sqlite and
  // more, a cost every ListAgents and SendMessage hook of every session would pay.
  const agyRoot = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli')
  return existsSync(join(agyConfigDir(), 'hooks.json')) || existsSync(agyRoot)
}

/** The board's payload when `nodes` (#619) or local non-Claude agents (#628) are present; null otherwise, with no call. */
async function boardPayload(raw: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  if (!isRecord(raw?.nodes) && !hasLocalOtherAgents(raw)) return null
  const body = await api(Number(raw?.port) || 12422, '/api/board', null, 3000).catch(() => null)
  return isRecord(body) ? body : null
}

/** ListAgents (#628): non-Claude sessions on this computer (`agy`, `pi`, `codex`, ...); null for none. */
async function localOtherAgentsContext(payload: Record<string, unknown> | null): Promise<string | null> {
  if (!payload) return null
  const { isOtherAgent, labelOf, targetsOf } = await import('../core/agent-send.ts')
  type Target = import('../core/agent-send.ts').Target
  const others = targetsOf(payload.items).filter(isOtherAgent)
  if (!others.length) return null
  const row = (t: Target): string => `  ${labelOf(t)}  ·  ${t.agent}  ·  ${t.sleeping ? 'asleep' : t.status || 'live'}`
  const asleep = others.filter(t => t.sleeping).sort((a, b) => b.activity - a.activity)
  const rows = [...others.filter(t => !t.sleeping), ...asleep.slice(0, LIST_MAX)].map(row)
  if (asleep.length > LIST_MAX)
    rows.push(
      `  ... and ${asleep.length - LIST_MAX} more asleep on this machine, not shown; SendMessage by name reaches them too`,
    )
  return (
    `Other agent sessions on this machine (not listed above: Claude Code knows only Claude sessions). ` +
    `SendMessage to one by name goes through the board: it types the message in once the session is free, waking ` +
    `it first if it sleeps, and the reply comes back as a board reminder. Two with one name: add the ref in ` +
    `brackets, as listed. \`board send "<name>" "<text>"\` does the same from a shell.\n${rows.join('\n')}`
  )
}

/** ListAgents (#619): the sessions on the board's nodes, each with its node and state; null for none. */
async function nodesContext(
  payload: Record<string, unknown> | null,
  raw: Record<string, unknown> | null,
): Promise<string | null> {
  if (!isRecord(raw?.nodes) || !payload) return null
  const { offlineDevices, labelOf, targetsOf } = await import('../core/agent-send.ts')
  type Target = import('../core/agent-send.ts').Target
  const offline = offlineDevices(payload)
  const row = (t: Target): string =>
    `  ${labelOf(t)}${t.agent && t.agent !== 'claude' ? `  ·  ${t.agent}` : ''}  ·  node ${t.device}  ·  ${t.sleeping ? 'asleep' : t.status || 'live'}` +
    (offline.has(t.device ?? '') ? '  ·  node offline now: goes out once it is back' : '')
  const onNodes = targetsOf(payload.items).filter(t => t.device)
  // Every live one, and the sleepers as this computer's are shown: at most LIST_MAX, the rest counted.
  const asleep = onNodes.filter(t => t.sleeping).sort((a, b) => b.activity - a.activity)
  const rows = [...onNodes.filter(t => !t.sleeping), ...asleep.slice(0, LIST_MAX)].map(row)
  if (asleep.length > LIST_MAX)
    rows.push(
      `  ... and ${asleep.length - LIST_MAX} more asleep on the nodes, not shown; SendMessage by name reaches them too`,
    )
  if (!rows.length) return null
  return (
    `Sessions on the board's nodes, other computers (not listed above: Claude Code knows only this computer's). ` +
    `SendMessage to one by name goes through the board: it types the message in once the session is free, waking ` +
    `it first if it sleeps, and the reply comes back as a board reminder. Two with one name: add the ref in ` +
    `brackets, as listed. \`board send "<name>" "<text>"\` does the same from a shell.\n${rows.join('\n')}`
  )
}

/**
 * SendMessage to `named` that neither this profile nor another Claude profile on this computer has:
 * first checks local non-Claude sessions (`agy`, `pi`, `codex`, #628) when present, then node
 * sessions (#619) when config.json has `nodes`. When neither applies, the board is asked nothing.
 */
async function sendToBoardTarget(named: string, input: Record<string, unknown>, raw: Record<string, unknown> | null) {
  const hasNodes = isRecord(raw?.nodes)
  const onNode = isRecord(raw?.node)
  if (!hasNodes && !onNode && !hasLocalOtherAgents(raw)) return
  // Claude Code's own addresses (a bridge's or a socket's) are never a name on the board.
  if (onNode && /^(uds|bridge):/i.test(named.trim())) return
  const message = isRecord(input.tool_input) ? input.tool_input.message : undefined
  if (typeof message !== 'string') return
  const sid = String(input.session_id ?? '') || process.env.CLAUDE_CODE_SESSION_ID || ''
  if (!sid) return
  const { createClaudeHome } = await import('../adapters/claude-home.ts')
  const live = [
    ...createClaudeHome(resolveProfileDir(process.env.CLAUDE_CONFIG_DIR, homedir())).liveSessions().values(),
  ]
  const A = await import('../core/agent-send.ts')
  const { to, ref } = A.parseTo(named)
  // This profile's own session of that name is Claude Code's, as before.
  if (live.some(s => s.name?.toLowerCase() === to && (ref.length < 8 || s.sessionId.toLowerCase().startsWith(ref))))
    return
  const payload = await boardPayload(raw)
  if (!payload && !onNode) return
  const all = A.targetsOf(payload?.items)
  const mine = all.find(t => t.key === sid)
  const name = mine?.name ?? live.find(s => s.sessionId === sid)?.name?.trim() ?? ''

  // Local non-Claude agent sessions (`agy`, `pi`, `codex`, #628) first.
  const localFits = A.matching(all.filter(A.isOtherAgent), named)
  if (localFits.length > 1)
    return deny(
      `Not sent: "${to}" fits more than one other agent session on this machine (${localFits.map(t => `${A.labelOf(t)} (${t.agent})`).join(', ')}). ` +
        `Send it to one of them as listed: its name with its ref, or its key.`,
    )
  const [localTarget] = localFits
  if (localTarget) {
    const m = A.messageText(message)
    if ('error' in m) return deny(`Not sent: ${m.error}.`)
    const { addEntry, schedulerRuns } = await import('../adapters/schedule-store.ts')
    try {
      addEntry(A.messageEntry(localTarget, m.text, { key: sid, name }, Date.now()))
    } catch (err) {
      return deny(
        `Not sent: ${localTarget.name} (${localTarget.agent}) is on this machine, and the board could not take the message: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const down = (await schedulerRuns(raw?.web !== false, async () => payload))
      ? ''
      : ' Note: no board with the scheduler is running now; it goes out once one runs.'
    return deny(
      `Queued for ${localTarget.name} (${localTarget.agent}) through the board (Claude Code reaches only Claude ` +
        `sessions, so it did not send it): the board types it in as a board reminder from ` +
        `${name || sid.slice(0, 8)} once ${localTarget.name} is free, waking it first if it sleeps.${down} Do not send it ` +
        `again. The reply comes back the same way, as a board reminder from ${localTarget.name}.`,
    )
  }

  // On a node (#639): the master's sessions, through its `board send`.
  if (!hasNodes) return onNode ? sendToMaster(named, message, sid, raw) : undefined
  // Node sessions (#619): only with `nodes` in config.json.
  const fits = A.matching(
    all.filter(t => t.device),
    named,
  )
  const [target] = fits
  if (!target) return
  if (fits.length > 1)
    return deny(
      `Not sent: "${to}" fits more than one session on the board's nodes (${fits.map(t => `${A.labelOf(t)} on node ${t.device}`).join(', ')}). ` +
        `Send it to one of them as listed: its name with its ref, or its key.`,
    )
  const m = A.messageText(message)
  if ('error' in m) return deny(`Not sent: ${m.error}.`)
  // Signed with this session's name on the board: `board send` on the node finds it by that name.
  const device = A.ownDeviceOf(payload) || 'the board'
  const { addEntry, schedulerRuns } = await import('../adapters/schedule-store.ts')
  try {
    addEntry(A.messageEntry(target, m.text, { key: sid, name, device }, Date.now()))
  } catch (err) {
    return deny(
      `Not sent: ${target.name} runs on node ${target.device}, and the board could not take the message: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const down = (await schedulerRuns(raw?.web !== false, async () => payload))
    ? ''
    : ' Note: no board with the scheduler is running now; it goes out once one runs.'
  deny(
    `Queued for ${target.name} on node ${target.device} through the board (Claude Code reaches only this ` +
      `computer's sessions, so it did not send it): the board types it in as a board reminder from ` +
      `${name || sid.slice(0, 8)} once ${target.name} is free, waking it first if it sleeps.${down} Do not send it ` +
      `again. The reply comes back the same way, as a board reminder from ${target.name}.`,
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
    // Wake not answering: nothing of its to go by, as before; a node still asks its master (#639).
    const sleeping = entries(await api(settings.port, '/sleeping', null, 3000).catch(() => null))
    if (!sleeping && isRecord(raw?.node)) return sendToBoardTarget(named, input, raw)
    const target = sleeping && own(sleeping).find(s => s.name.toLowerCase() === to)
    if (sleeping && !target) {
      if (await sendElsewhere(to, ref, input, sleeping, settings.port, raw)) return
      // Nothing in Claude profiles on this computer has the name: a local non-Claude (#628) or node (#619) session may.
      return sendToBoardTarget(named, input, raw)
    }
    // By its session id: its name may be another profile's sleeper's too.
    const id = target && [target.session, target.pane].find(v => typeof v === 'string' && v !== '')
    if (!target || !id) return
    const r = await api(settings.port, '/wake', { target: id }, 170_000)
    if (isRecord(r) && !r.ok)
      deny(`${target.name} is asleep (the board's wake) and could not be woken: ${String(r.error)}`)
    return
  }

  // /awake is newer than /sleeping: an older router answers 404, then only the sleepers show.
  // On a node (#639) the master's list is asked beside wake's; nowhere else.
  const master = isRecord(raw?.node) ? masterContext(raw, input).catch(() => null) : null
  const [list, running] = await Promise.all([
    api(settings.port, '/sleeping', null, 3000).catch(() => null),
    api(settings.port, '/awake', null, 3000).catch(() => null),
  ])
  const sleeping = entries(list)
  const say = (context: string): void =>
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }))
  if (!sleeping) {
    const onMaster = await master
    if (onMaster) say(onMaster)
    return
  }
  const awake = entries(running)
  const ownPart = listContext(own(sleeping), awake && own(awake), settings.port, settings.listSleepingDays)
  // The other profiles' part on its own: whatever goes wrong there, this profile's still shows.
  let others: string | null = null
  try {
    const set = otherProfiles()
    others = set && othersContext(sleeping, awake, set.others, settings.listSleepingDays)
  } catch {}
  // One board fetch shared by local non-Claude agents (#628) and node sessions (#619); none for plain Claude setups.
  const payload = await boardPayload(raw).catch(() => null)
  const localOthers = await localOtherAgentsContext(payload).catch(() => null)
  const onNodes = await nodesContext(payload, raw).catch(() => null)
  const onMaster = await master
  const context = [ownPart, others, localOthers, onNodes, onMaster].filter(Boolean).join('\n\n')
  if (context) say(context)
}

// Wake not running or not answering, or input that does not parse: leave the tool call alone.
main().catch(() => {})
