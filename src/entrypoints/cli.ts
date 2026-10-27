// `board`: how agents keep their card current. Prints one line, so a call costs next to nothing.
//   board                    show this session's card
//   board cat <id> [title]   set the category (lane); a new id with a title is added to the config
//   board doing <text>       what the session works on now
//   board wait <text>        what it waits for outside the chat (moves the card to "waiting")
//   board ask <question>     needs the user: "Needs me" until the user's next prompt
//   board done [text]        task finished: clears doing, wait and ask, keeps the result
//   board clear              clears doing, wait, ask and result
//   board favorite [off]     keeps the session in sight: first in its column, whole however long
//                            it idles or sleeps, left out of a tidy-up (off: back among the others)
//   board list               every session on the board, one line each
//   board cats               the known categories
//   board remind <when> <text>   the board types "[board reminder] <text>" into the session then,
//                            waking it if it sleeps (when: in 30m, at 15:30, tomorrow 9:00, ...)
//   board every <cron> <text>    the same on a cron schedule (5 fields, quoted)
//   --idle (remind, every)   wait until the session is free; by default it arrives on time,
//                            queued into a running turn
//   board restart [text]     once this turn is over and the session is free, the board has
//                            herdr-wake put it to sleep and wake it again (MCP servers, settings,
//                            hooks and skills load anew, the conversation stays), then types
//                            "[board reminder; restarted as you asked] <text>" into it
//   board schedule [--all]   this session's entries (every session's)
//   board unschedule <id|all>    removes an entry (all: every entry of this session)
//   board call-report --session <id> --file <report.md> [--report-id <stable-id>]
//                            a MokuPilot call's results (services/mokupilot.ts) for the
//                            session it was a fork of: the board types them in once the session
//                            is free, for its information, waking it if it sleeps
//   board archive --session <id|name|pane>   takes a finished session off the board: its pane
//                            closes, the user can bring it back from the board's archive (services/archive.ts)
//   board sleep <id|name|pane>...   puts those sessions to sleep at once through herdr-wake, a line
//                            for each: asleep, or kept up and why (services/sleep.ts); with
//                            --when-free the busy ones go to sleep once they are free; --self
//                            puts this session to sleep too, once its turn is over; pi sessions
//                            too, with the board's own wake (#178). `board sleep <pane>
//                            --pi-session <file>`: a pane where pi was stopped by hand, a shell
//                            now, taken as that pi session asleep there
//   board fork [--name <Name>] [note]   a fork of this session (or --session's): a new session in
//                            a new tab with a copy of its conversation, started by the web board as
//                            its Fork does (services/launch/fork.ts); the note is its first message
//   board tunnel [on|off|test]   the board through the owner's own domain (core/tunnel.ts): where
//                            the tunnel stands; on and off in config.json; test runs Test connection
//   board login link|reset   the board on its own server (core/on-server.ts): link prints the
//                            first login's one-time link (a fresh code) while no login is set, and
//                            exits 3 when one is; reset clears the password, the code and the
//                            passkeys, ends every login and prints a new link. Outside server mode
//                            both refuse
//   board doctor             what is set up on this computer, and what is missing (core/setup.ts)
//   board presence [here|away]   whether the user is at the computer or away (core/presence.ts),
//                            the line every session's context has; with a state, the user's switch
//   board away [on|off]      the same switch: away (on, the default) or back at the computer (off).
//                            Both only while config.json turns presence on; never sent to a session
//   board resume <session id> [--profile <id>]   resumes that session here, in the profile its
//                            card says it ran in (else the one named): what herdr types into a
//                            restored pane for a session in another profile than the default one
//                            (core/resume.ts); runs Claude in the foreground, exits with its code;
//                            in the session's project folder, found from its transcript, when
//                            this folder is not it
//   board resume --pi <pi session id>   resumes a pi session wake put to sleep (#178) here: pi
//                            on its session file with the command line it had, without what would
//                            start another conversation, and the Claude account folder it had
//                            (core/wake/pi.ts); what wake types into its pane to wake it
//   board tg-key             the Telegram topic of this pane's herdr tab, which claude-tg puts in
//                            TG_KEY (core/wake/topics.ts keyFor); outside herdr, or with a herdr
//                            that does not answer within 5 s, the folder; always exits 0. For the
//                            launchers (core/wake/launchers.ts), so not in the usage line
// --session <id|name|pane> targets another session's card (for coordinating sessions).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readArchiveLog } from '../adapters/archive-store.ts'
import {
  enqueueReport,
  getReceipt,
  type Receipt,
  readReport,
  reportHash,
  reportIdentity,
} from '../adapters/call-receipts.ts'
import { readCard, writeCard } from '../adapters/cards.ts'
import { createClaudeHome, cwdOf } from '../adapters/claude-home.ts'
import { configFile, editCategories, loadConfig, setRemoteOn, setTunnelOn } from '../adapters/config-file.ts'
import { asSnapshot, type HerdrPane, herdr, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { boardFile } from '../adapters/paths.ts'
import { findPiSession } from '../adapters/pi-home.ts'
import { currentPresence, setPresence } from '../adapters/presence-store.ts'
import { runHere } from '../adapters/process.ts'
import type { LiveHit } from '../adapters/profile-homes.ts'
import { addEntry, askRestart, listEntries, type NewEntry, removeEntry } from '../adapters/schedule-store.ts'
import { peekPiSleepers } from '../adapters/wake-files.ts'
import { COLUMNS, noteOf, statusText } from '../core/board.ts'
import { categoryFor, categoryInfo, laneRank } from '../core/categories.ts'
import { CODEX_AGENT } from '../core/codex.ts'
import { translator } from '../core/i18n/translator.ts'
import { t, useLanguage } from '../core/lang.ts'
import { serverModeChecks, serverModeOf, serverModeProblems } from '../core/on-server.ts'
import { isPiSessionFile, piSessionId } from '../core/pi.ts'
import { type PresenceState, presenceConfig, presenceLine } from '../core/presence.ts'
import { type ProfileSet, profileSet, resolveProfileDir, sessionProfile } from '../core/profiles.ts'
import { type RemoteView, remoteConfig } from '../core/remote.ts'
import { parseResume, projectFolderName, resumeDir, resumePlan } from '../core/resume.ts'
import { MAX_REPORT, promptOf, type ScheduleEntry, type SessionRef } from '../core/schedule-rules.ts'
import { boardPorts, publicOrigin, type TestStep, tunnelChecks, tunnelConfig, tunnelProblems } from '../core/tunnel.ts'
import type { Item } from '../core/types.ts'
import { wakeConfig } from '../core/wake/config.ts'
import { parsePiResume, piResumeArgv, piResumeEnv } from '../core/wake/pi.ts'
import { keyFor, type TopicSnapshot } from '../core/wake/topics.ts'
import { type Cron, nextRun, parseCron, parseWhen, shortestGap } from '../core/when.ts'
import { shortWhen } from '../core/when-format.ts'
import { checkWake, wakeAnswers } from '../services/actions.ts'
import { askArchive, closeDue, getArchived, profileDoubt } from '../services/archive.ts'
import { collect } from '../services/board.ts'
import { defaultDeps } from '../services/deps.ts'
import { type SleepOutcome, sessionsFor, sleepMany } from '../services/sleep.ts'
import { currentWakeMode } from '../services/wake/mode.ts'

const USAGE = `board [cat <id> ["<Title>"] | doing <text> | wait <text> | ask <question> | done [text] | clear | favorite [off] | list | cats | remind <when> "<text>" [--idle] | every "<cron>" "<text>" [--idle] | restart ["<note for after>"] | archive --session <id|name|pane> | sleep <id|name|pane>... [--when-free] [--self] | fork [--name "<Name>"] ["<note>"] | schedule [--all] | unschedule <id|all> | call-report --session <id> --file <report.md> [--report-id <stable-id>] | remote [on | off | pwa on|off | approve <id> | deny <id> | revoke <id>] | tunnel [on | off | test] | login [link | reset] | doctor | presence [here | away] | away [on | off] | resume <session id> [--profile <id>] | resume --pi <pi session id>] [--session <id|name|pane>]`
const MIN_REPEAT_MS = 5 * 60_000
const WHEN_HELP = 'in 30m, in 2h, at 15:30, tomorrow 9:00, fri 17:00, 2026-10-20 14:00 (local time)'

const args = process.argv.slice(2)
let target: string | undefined
const si = args.indexOf('--session')
if (si >= 0) {
  target = args[si + 1]
  args.splice(si, 2)
}
// fork: the new session's name.
let forkName: string | undefined
const ni = args.indexOf('--name')
if (ni >= 0) {
  forkName = args[ni + 1]
  args.splice(ni, 2)
}
// remind, every: wait until the session is free instead of arriving on time, mid-turn if need be.
const ii = args.indexOf('--idle')
const idle = ii >= 0
if (idle) args.splice(ii, 1)
const mode = (): { idle?: true } => (idle ? { idle: true } : {})
// sleep: the ones that are busy now go to sleep once they are free, instead of staying up.
const wi = args.indexOf('--when-free')
const whenFree = wi >= 0
if (whenFree) args.splice(wi, 1)
// sleep: this session too, once it is free; a word of any other command's text stays.
const mi = args[0] === 'sleep' ? args.indexOf('--self') : -1
const self = mi >= 0
if (self) args.splice(mi, 1)
// sleep: a pane where pi was stopped by hand, taken as that session asleep there (#178).
let piSessionFile: string | undefined
const pi = args[0] === 'sleep' ? args.indexOf('--pi-session') : -1
if (pi >= 0) {
  piSessionFile = args[pi + 1] ?? ''
  args.splice(pi, 2)
}
const modeText = (): string => (idle ? ', when the session is free' : '')
const [cmd = 'show', ...rest] = args
const text = rest.join(' ').replace(/\s+/g, ' ').trim()
const cfg = loadConfig()
const deps = defaultDeps(cfg)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The session a command is about. */
interface Session {
  key: string
  cwd: string
  name?: string | undefined
  pane?: string | null | undefined
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const paneOf = async (pane: string): Promise<HerdrPane | undefined> =>
  (await snapshot()).panes.find(x => x.pane_id === pane)

/** A real Claude child has a new id; a root Codex can carry the Claude id its hook recorded. */
function codexCaller(): boolean {
  const codex = process.env.CODEX_THREAD_ID
  if (!codex) return false
  const claude = process.env.CLAUDE_CODE_SESSION_ID
  return !claude || readCard(codex)?.codexParentClaude === claude
}

/** A Codex child inherits its parent's pane env; only the reported root session owns its card. */
function codexSession(p: HerdrPane | undefined): (Session & { name: string }) | null {
  if (p?.agent !== CODEX_AGENT) return null
  const own = process.env.CODEX_THREAD_ID
  const pane = process.env.HERDR_PANE_ID
  if (own && p.agent_session?.value === own)
    return { key: own, cwd: p.cwd ?? '', pane, name: p.terminal_title_stripped || own.slice(0, 8) }
  throw new Error('cannot tell which Codex session this is: use its herdr pane, or pass --session')
}
/**
 * The sessions running in every profile listed, hidden ones too, this env's own folder first (its
 * answer wins), as the board reads them (services/board.ts collect).
 */
const liveSessions = (): Map<string, LiveHit> => {
  const profiles = deps.profiles()
  return deps.homes.liveSessions([profiles.inheritedDir, ...profiles.list.map(p => p.dir)])
}

/** { key, cwd } of the session the command is about. */
async function resolveSession(): Promise<Session> {
  if (target) {
    if (UUID.test(target)) return { key: target, cwd: '' }
    const t = target.toLowerCase()
    const item = (await collect(deps)).find(i =>
      [i.name, i.autoName, i.pane, i.session].some(v => v && v.toLowerCase() === t),
    )
    if (!item) throw new Error(`no session "${target}" on the board`)
    return { key: item.key, cwd: item.cwd, name: item.name, pane: item.pane }
  }
  const pane = process.env.HERDR_PANE_ID
  const fromCodex = codexCaller()
  let reported: HerdrPane | undefined
  if (fromCodex && pane) {
    reported = await paneOf(pane)
    const codex = codexSession(reported)
    if (codex) return codex
  }
  const own = process.env.CLAUDE_CODE_SESSION_ID
  if (own) {
    return {
      key: own,
      cwd: process.cwd(),
      name: liveSessions().get(own)?.session.name,
      pane: process.env.HERDR_PANE_ID,
    }
  }
  if (pane) {
    const p = fromCodex ? reported : await paneOf(pane)
    if (p?.agent) return { key: p.agent_session?.value ?? `pane-${pane}`, cwd: p.cwd ?? '', pane }
  }
  throw new Error('cannot tell which session this is: run it from a Claude session, or pass --session')
}

/** The session running this command, { key, name }, or null outside one. */
async function ownSession(): Promise<SessionRef | null> {
  const own = process.env.CLAUDE_CODE_SESSION_ID
  const pane = process.env.HERDR_PANE_ID
  let p: HerdrPane | undefined
  try {
    if (pane) p = await paneOf(pane)
  } catch {}
  if (codexCaller()) {
    try {
      const codex = codexSession(p)
      if (codex) return { key: codex.key, name: codex.name }
      if (!p) return null
    } catch {
      return null
    }
  }
  const key = own || (p?.agent ? (p.agent_session?.value ?? `pane-${pane}`) : null)
  if (!key) return null
  const name = (own && liveSessions().get(own)?.session.name) || p?.terminal_title_stripped || key.slice(0, 8)
  return { key, name }
}

/**
 * Where an entry is for: the session, and its pane and folder, which find it again after /clear
 * gives it a new id. The folder is the pane's as herdr sees it (what the scheduler compares
 * with), not this shell's, which a `cd` may have moved; `from` is who set it, when that is
 * another session.
 */
async function entryFor(s: Session) {
  let cwd = ''
  try {
    if (s.pane) cwd = (await paneOf(s.pane))?.cwd ?? ''
  } catch {}
  cwd ||= liveSessions().get(s.key)?.session.cwd || s.cwd || ''
  const setter = target ? await ownSession() : null
  return {
    key: s.key,
    name: s.name ?? '',
    ...(s.pane && { pane: s.pane }),
    ...(cwd && { cwd }),
    ...(setter && setter.key !== s.key && { from: setter }),
  }
}

/** The web board's payload when it answers now (asked once), else null. */
let webBoard: Promise<Record<string, unknown> | null> | undefined
function boardAnswer(): Promise<Record<string, unknown> | null> {
  webBoard ??= (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port ?? 12422}/api/board`, { signal: AbortSignal.timeout(1500) })
      const body: unknown = await res.json()
      return isRecord(body) ? body : null
    } catch {
      return null
    }
  })()
  return webBoard
}

/** Whether a board that runs the schedule answers now. */
async function schedulerRuns(): Promise<boolean> {
  try {
    if (cfg.web === false) {
      // The terminal board runs the schedule itself then (entrypoints/tui.ts).
      const board: unknown = JSON.parse(readFileSync(boardFile(), 'utf8'))
      const pid = isRecord(board) ? board.pid : undefined
      if (typeof pid !== 'number') return false
      process.kill(pid, 0)
      return true
    }
    const body = await boardAnswer()
    return !!body && 'schedules' in body
  } catch {
    return false
  }
}

/**
 * The profiles with the board's own: the folder the running web board says its env points to
 * (its payload's `inherited` profile). This command runs in a session's env, which may be another
 * profile's than the board's (and herdr's); with no board answering, it is the best there is.
 */
async function boardProfiles(): Promise<ProfileSet> {
  const set = deps.profiles()
  const body = cfg.web === false ? null : await boardAnswer()
  const listed = Array.isArray(body?.profiles) ? body.profiles : []
  const own = listed.find(p => isRecord(p) && p.inherited === true)
  return isRecord(own) && typeof own.dir === 'string' ? profileSet(set.list, own.dir) : set
}

/** A note for the agent when no board with the scheduler runs to send it. */
async function schedulerNote(): Promise<string> {
  if (await schedulerRuns()) return ''
  return ' · note: no board with the scheduler is running now; this goes out once one runs (late, with a note)'
}

// Times for agents: unambiguous, in local time.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromNow(ms: number, now: number): string {
  const min = Math.round(Math.abs(ms - now) / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const parts = d ? [`${d} d`, h && `${h} h`] : h ? [`${h} h`, min % 60 && `${min % 60} min`] : [`${min} min`]
  const span = parts.filter(Boolean).join(' ')
  return ms >= now ? `in ${span}` : `${span} ago`
}
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** How far a restart got, for its line; a sleep (no steps) how it waits. */
function restartState(e: ScheduleEntry): string {
  if (e.failed) return `did not happen (${String(e.failed)}), tells the session once it is free`
  if (e.step === 'note') return 'restarted, the note goes in once the session is free'
  if (e.step) return 'under way'
  const HELD: Record<string, string> = {
    tasks: 'background tasks run',
    draft: 'unsent text in its input box',
    dialog: 'a dialog is open',
    gone: 'the session is not on the board',
  }
  const why = typeof e.why === 'string' ? e.why : ''
  const held = Object.hasOwn(HELD, why) ? HELD[why] : undefined
  const refused = e.attempts && why && why !== 'busy' ? ` (${wakeName()} refused, tries again: ${why})` : ''
  return `once the session is free${held ? ` (waits: ${held})` : refused}`
}

/** The wake the board talks to, as its lines name it: the board's own (#119), else the separate herdr-wake plugin, as before. */
const wakeName = (): string => (currentWakeMode(cfg).kind === 'new' ? 'wake' : 'herdr-wake')

function entryLine(e: ScheduleEntry, now: number, withSession: boolean): string {
  const parts =
    e.kind === 'restart' || e.kind === 'sleep'
      ? [e.id, `${e.kind}, asked ${stamp(e.created ?? e.next)}`, restartState(e)]
      : [
          e.id,
          `${stamp(e.next)} (${fromNow(e.next, now)})`,
          e.cron ? `every "${e.cron}"` : 'once',
          e.idle ? 'when free' : 'on time',
        ]
  if (withSession) parts.push(e.name || e.key)
  if (e.pendingSince && e.kind !== 'restart' && e.kind !== 'sleep')
    parts.push(`due, waits for the session since ${stamp(Number(e.pendingSince))}`)
  if (e.text) parts.push(clip(e.text, 80))
  return parts.join(' · ')
}

function line(key: string, cwd: string): string {
  const card = readCard(key) ?? {}
  const cat = card.category || categoryFor(cfg, cwd)
  const parts = [cat ? `${cat}${card.category ? '' : ' (guessed)'}` : 'category: not set']
  if (card.doing) parts.push(`doing: ${card.doing}`)
  if (card.wait) parts.push(`waiting: ${card.wait}`)
  if (card.ask) parts.push(`asks the user: ${card.ask}`)
  if (card.result) parts.push(`done: ${card.result}`)
  if (card.favorite) parts.push('favorite')
  return parts.join(' · ')
}

/**
 * `board presence [here|away]` and `board away [on|off]`: the user's presence (#172), read or
 * switched in its file, so with the board closed too; the board shows a switch at its next look.
 * While config.json has no `presence` it is off, and a switch is refused: no file appears.
 */
function presence(): void {
  const word = (rest[0] ?? '').toLowerCase()
  const state: PresenceState | null =
    cmd === 'away'
      ? word === '' || word === 'on'
        ? 'away'
        : word === 'off'
          ? 'here'
          : null
      : word === ''
        ? null
        : word === 'here' || word === 'away'
          ? word
          : null
  if (word && !state)
    throw new Error(cmd === 'away' ? 'usage: board away [on|off]' : 'usage: board presence [here|away]')
  if (!presenceConfig(cfg.presence)) {
    if (!state) {
      console.log('presence is off (no "presence" in config.json; Settings → Presence turns it on)')
      return
    }
    throw new Error(t('err.presenceOff'))
  }
  if (!state) {
    console.log(presenceLine(currentPresence()))
    return
  }
  const { presence: p, changed } = setPresence(state, 'user', process.env.HERDR_PANE_ID ? 'agent' : 'cli')
  console.log(`ok · ${changed ? '' : 'already '}${p.state === 'away' ? 'away' : 'here'}`)
}

async function main(): Promise<void> {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE)

  if (cmd === 'cats') {
    const known = cfg.categories.map(c => `${c.id} (${categoryInfo(cfg, c.id).title})`).join(', ')
    return console.log(`${known}. A new id makes a new lane. Config: ${configFile()}`)
  }

  if (cmd === 'list') {
    const items = await collect(deps)
    const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
    items.sort(
      (a, b) =>
        laneRank(cfg, a.category) - laneRank(cfg, b.category) ||
        a.category.localeCompare(b.category) ||
        (order.get(a.column) ?? 0) - (order.get(b.column) ?? 0),
    )
    const soonest = new Map<string, number>()
    for (const e of listEntries()) if (!soonest.has(e.key)) soonest.set(e.key, e.next)
    for (const i of items) {
      const col = COLUMNS.find(c => c.id === i.column)?.title
      const note = noteOf(i)
      const next = soonest.get(i.key)
      const alarm = next !== undefined ? ` ⏰ ${shortWhen(next, t)}` : ''
      console.log(
        `${i.name} [${i.category}] ${col}${i.sleeping ? ` (${statusText('sleeping')})` : ''}${alarm}${note ? `: ${note.slice(0, 80)}` : ''}`,
      )
    }
    return
  }

  if (cmd === 'doctor') {
    const { gatherFacts } = await import('../adapters/setup-facts.ts')
    const { checkSetup, report } = await import('../core/setup.ts')
    const checks = checkSetup(await gatherFacts(cfg), t)
    const webPort = Number(cfg.port) || 12422
    // The remote mode's own checks, only while it is on: off, Tailscale is never asked.
    if (remoteConfig(cfg.remote).on) {
      const { phoneChecks } = await import('../core/pwa.ts')
      const { phoneFacts } = await import('../services/pwa.ts')
      checks.push(...phoneChecks(await phoneFacts(cfg, webPort), t))
    }
    // The tunnel's, likewise: off, neither ssh-keygen nor the running board is asked.
    if (tunnelConfig(cfg.tunnel).on) {
      const { tunnelFacts } = await import('../services/tunnel-facts.ts')
      checks.push(...tunnelChecks(await tunnelFacts(cfg, webPort), t))
    }
    // The board on its own server's: its settings, the listener on its socket, the login. On a PC
    // nothing of it is asked.
    const server = serverModeOf(cfg.serverMode)
    if (server) {
      const { onServerFacts } = await import('../services/first-login.ts')
      checks.push(...serverModeChecks(await onServerFacts(server), t))
    }
    return console.log(report(checks, t))
  }

  // Neither needs to know which session asks.
  if (cmd === 'schedule' && rest.includes('--all')) {
    const list = listEntries()
    if (!list.length) return console.log('nothing scheduled')
    for (const e of list) console.log(entryLine(e, Date.now(), true))
    return
  }
  if (cmd === 'unschedule' && rest[0] && rest[0].toLowerCase() !== 'all') {
    const e = removeEntry(rest[0].toLowerCase())
    if (!e) throw new Error(`no entry "${rest[0]}"; see board schedule`)
    return console.log(
      `ok · removed ${e.id} (${e.cron ? `every "${e.cron}"` : stamp(e.next)}${e.name ? `, ${e.name}` : ''}): ${clip(e.text)}`,
    )
  }
  if (cmd === 'call-report') return callReport()
  if (cmd === 'remote') return remote()
  if (cmd === 'tunnel') return tunnel()
  if (cmd === 'login') return login()
  if (cmd === 'archive') return archive()
  if (cmd === 'sleep') return sleep()
  if (cmd === 'fork') return fork()
  if (cmd === 'resume') return rest.includes('--pi') ? resumePi() : resume()
  if (cmd === 'tg-key') return tgKey()
  if (cmd === 'presence' || cmd === 'away') return presence()

  const s = await resolveSession()
  const now = Date.now()
  switch (cmd) {
    case 'show':
      break
    case 'cat': {
      const id = (rest[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (!id) throw new Error(`usage: board cat <id> ["<Title>"]; known: ${cfg.categories.map(c => c.id).join(', ')}`)
      // A new id with a title becomes a real category (config.json), not just a lane named by its id.
      const title = rest.slice(1).join(' ').trim()
      if (title && !cfg.categories.some(c => c.id === id)) {
        const r = editCategories({ op: 'create', id, title })
        if (!r.ok) throw new Error(r.error)
        // As editCategories saved it: no color given is blue, no folders.
        cfg.categories.push({ id, title, color: 'blue', paths: [] })
      }
      writeCard(s.key, { category: id })
      break
    }
    case 'doing':
      if (!text) throw new Error('usage: board doing <text>')
      // Back at work: whatever it waited for has arrived, whatever it asked is settled.
      writeCard(s.key, { doing: text, wait: '', waitSince: '', ask: '', askSince: '', result: '', by: 'agent' })
      break
    case 'wait':
      if (!text) throw new Error('usage: board wait <text>')
      writeCard(s.key, { wait: text, waitSince: now, by: 'agent' })
      break
    case 'ask':
      // Needs the user: the card goes to "Needs me" until the user's next prompt (entrypoints/hook.ts clears it).
      if (!text) throw new Error('usage: board ask <question>')
      writeCard(s.key, { ask: text, askSince: now, by: 'agent' })
      break
    case 'done':
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: text, by: 'agent' })
      break
    case 'clear':
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '' })
      break
    case 'favorite': {
      const off = rest[0]?.toLowerCase()
      if (off !== undefined && off !== 'off') throw new Error('usage: board favorite [off]')
      writeCard(s.key, { favorite: off ? '' : true })
      break
    }
    case 'remind': {
      // The time is the first one to five words that read as one; the rest is the text.
      let at: number | null = null
      let words = 0
      for (let k = Math.min(5, rest.length - 1); k >= 1 && at === null; k--) {
        at = parseWhen(rest.slice(0, k).join(' '), now)
        words = k
      }
      const msg = rest.slice(words).join(' ').replace(/\s+/g, ' ').trim()
      if (at === null || !msg) throw new Error(`usage: board remind <when> "<text>"; when: ${WHEN_HELP}`)
      if (at <= now) throw new Error(`${stamp(at)} is in the past`)
      if (at > now + 5 * 366 * 86_400_000) throw new Error(`${stamp(at)} is more than five years ahead`)
      const e = addEntry({ ...(await entryFor(s)), ...mode(), text: msg, at, next: at, by: 'agent' })
      return console.log(
        `ok · reminder ${e.id} ${stamp(at)} (${fromNow(at, now)}${modeText()}): ${clip(msg)} · cancel: board unschedule ${e.id}${await schedulerNote()}`,
      )
    }
    case 'every': {
      // The cron in one quoted word, or its five fields as they are (PowerShell leaves * alone).
      let expr = rest[0] ?? ''
      let words = 1
      if (!/\s/.test(expr) && !expr.startsWith('@') && rest.length > 5) {
        expr = rest.slice(0, 5).join(' ')
        words = 5
      }
      let cron: Cron
      try {
        cron = parseCron(expr)
      } catch (err) {
        throw new Error(
          `${messageOf(err)}. usage: board every "<minute hour day month weekday>" "<text>", e.g. board every "0 9 * * 1-5" "check the inbox"; quote the schedule`,
        )
      }
      const msg = rest.slice(words).join(' ').replace(/\s+/g, ' ').trim()
      if (!msg) throw new Error('usage: board every "<cron>" "<text>"')
      const next = nextRun(cron, now)
      if (next === null) throw new Error(`"${cron.expr}" never runs`)
      // Every run is a turn of the session, waking it if need be.
      if (shortestGap(cron, now) < MIN_REPEAT_MS)
        throw new Error(
          `"${cron.expr}" runs more often than every ${MIN_REPEAT_MS / 60_000} minutes; for a one-off wait use board remind`,
        )
      const e = addEntry({ ...(await entryFor(s)), ...mode(), text: msg, cron: cron.expr, next, by: 'agent' })
      return console.log(
        `ok · every ${e.id} "${cron.expr}", next ${stamp(next)} (${fromNow(next, now)}${modeText()}): ${clip(msg)} · cancel: board unschedule ${e.id}${await schedulerNote()}`,
      )
    }
    case 'restart':
      return restart(s)
    case 'schedule': {
      const list = listEntries().filter(e => e.key === s.key)
      if (!list.length) return console.log('nothing scheduled for this session')
      for (const e of list) console.log(entryLine(e, now, false))
      return
    }
    case 'unschedule': {
      // An id is removed above, whoever set it; here only "all" of this session's.
      if (rest[0]?.toLowerCase() !== 'all') throw new Error('usage: board unschedule <id|all>')
      const mine = listEntries().filter(e => e.key === s.key)
      for (const e of mine) removeEntry(e.id)
      return console.log(`ok · removed ${mine.length} ${mine.length === 1 ? 'entry' : 'entries'}`)
    }
    default:
      throw new Error(`unknown command "${cmd}". ${USAGE}`)
  }
  const cat = readCard(s.key)?.category
  const extra = cat && !cfg.categories.some(c => c.id === cat) ? ` (new lane "${categoryInfo(cfg, cat).title}")` : ''
  console.log(`ok · ${line(s.key, s.cwd)}${extra}`)
}

/**
 * What `board restart` and `board sleep` need and do not have, from wakeAnswers: wake, turned off
 * in config.json (#119), or not answering; else herdr-wake at wakeUrl, as before.
 */
function wakeMissing(up: { why: string }): string {
  if (up.why === 'off') return 'wake, and it is off (Settings → Sleep and wake…)'
  const mode = currentWakeMode(cfg)
  if (mode.kind === 'new') return `wake, which does not answer at ${mode.url} (${up.why})`
  return up.why
    ? `herdr-wake, which does not answer at ${cfg.wakeUrl} (${up.why})`
    : "herdr-wake, and wakeUrl in the board's config.json is empty"
}

/**
 * `board restart [note]`: the session restarted once it is free, a schedule entry of kind
 * 'restart' (services/scheduler.ts). Refused at once without herdr-wake, which does the restart,
 * outside herdr, and when the board would not wake the session again (its profile guard,
 * services/actions.ts checkWake: herdr-wake resumes it in its pane's env); asked again, the
 * restart already on its way takes the new note.
 */
async function restart(s: Session): Promise<void> {
  // The board's own idea of the sessions, asked once: herdr not answering is none.
  let known: Item[] | undefined
  const items = async (): Promise<Item[]> => (known ??= await collect(deps).catch((): Item[] => []))
  const find = async (key: string) => (await items()).find(i => i.key === key || i.session === key)
  // A session given by its id: its pane, from the board's own idea of it.
  if (!s.pane && target) {
    const item = await find(s.key)
    if (item) s = { ...s, pane: item.pane, cwd: item.cwd, name: item.name }
  }
  if (!s.pane)
    throw new Error(
      `board restart works for a session in a herdr pane, and ${target ? `herdr has none for "${target}"` : 'this one runs outside herdr'}; nothing was scheduled`,
    )
  const up = await wakeAnswers(deps)
  if (!up.ok)
    throw new Error(
      `a restart needs ${wakeMissing(up)}; nothing was scheduled. Ask the user to restart this session by hand: /exit in it, then claude --resume ${s.key} in the same pane`,
    )
  // The restart ends in a wake: one the board would refuse (another profile than herdr-wake would
  // resume it in, or one not known) is refused now, before anything is scheduled. The session as
  // the board shows it, else as its card says.
  const set = await boardProfiles()
  const shown = await find(s.key)
  const guard = await checkWake(
    deps,
    shown ?? {
      name: s.name || s.key.slice(0, 8),
      pane: s.pane,
      session: s.key,
      cwd: s.cwd,
      ...sessionProfile(readCard(s.key), set.list),
    },
    set,
  )
  if (!guard.ok) throw new Error(`${guard.error}; nothing was scheduled`)
  const { entry, again } = askRestart({ ...(await entryFor(s)), text, by: 'agent' })
  const own = !entry.from
  const prompt = clip(promptOf(entry, Date.now()), 160)
  const head = again
    ? `ok · restart ${entry.id} is on its way already${text ? ', with this note' : ''}`
    : `ok · restart ${entry.id}`
  const turn = own ? 'once this turn is over and the session is free' : 'once the session is free'
  const stops = own
    ? ' · end your turn now. It waits for background commands and Monitor to end (10 min at most, then tells you it did not happen); CronCreate and ScheduleWakeup jobs die with it'
    : ''
  console.log(
    `${head}: ${turn}, Claude exits and resumes in the same pane (MCP servers, settings, hooks, skills and CLAUDE.md load anew, the conversation stays), then gets "${prompt}"${stops} · cancel: board unschedule ${entry.id}${await schedulerNote()}`,
  )
}

/**
 * `board fork [--name <Name>] [note]`: a fork of this session (or --session's), started by the web
 * board as its Fork button does (services/launch/fork.ts): a new tab with a copy of the
 * conversation, the session's folder, lane, workspace and profile; the session itself goes on as
 * it is. Without a web board answering there is no fork: it is the board that starts it.
 */
async function fork(): Promise<void> {
  const s = await resolveSession()
  if (cfg.web === false) throw new Error('board fork goes through the web board, and config.json turns it off')
  const res = await fetch(`http://127.0.0.1:${cfg.port ?? 12422}/api/session/${encodeURIComponent(s.key)}/fork`, {
    method: 'POST',
    headers: { 'X-Board': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(forkName && { name: forkName }), ...(text && { message: text }) }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!res) throw new Error('the web board does not answer, and board fork goes through it (board doctor)')
  const body: unknown = await res.json().catch(() => null)
  if (!isRecord(body) || body.ok !== true)
    throw new Error(String((isRecord(body) && body.error) || `the web board answered ${res.status}`))
  console.log(
    `ok · fork "${String(body.name)}" of ${s.name || s.key.slice(0, 8)} starts in a new tab with a copy of the conversation; its card is on the board`,
  )
}

/**
 * `board resume <session id> [--profile <id>]`: the session resumed in this terminal, in its own
 * profile (core/resume.ts resumePlan), with Claude in the foreground; exits with Claude's code.
 * herdr types it into a restored pane, so it asks herdr nothing. Claude runs in the session's
 * project folder (resumeFolder), so a wake into a pane in another folder types no `cd`.
 */
async function resume(): Promise<void> {
  const o = parseResume(rest)
  const plan = resumePlan({
    ...o,
    card: readCard(o.session),
    // The list the wake process reads too (services/deps.ts profiles): the listed and found
    // folders, and the one this env points to.
    profiles: deps.profiles().list,
    launch: cfg.launch,
    env: process.env,
    home: homedir(),
  })
  const [file = 'claude', ...argv] = plan.argv
  const dir = plan.dir ?? resolveProfileDir(process.env.CLAUDE_CONFIG_DIR, homedir())
  const ran = await runHere(file, argv, plan.env, (await resumeFolder(o.session, dir)) ?? undefined)
  if (ran.error) throw new Error(`${file} did not start: ${messageOf(ran.error)}`)
  process.exit(ran.code)
}

/**
 * `board resume --pi <id>`: a pi session wake put to sleep resumed in this terminal (#178), as wake
 * keeps it (its pi file, read only): pi with the command line it had, without what would start
 * another conversation (core/wake/pi.ts piResumeArgv), on its session file, with the Claude account
 * folder it slept with, in its folder. One wake does not know is found by its id among pi's
 * session files and resumed with `pi --session <file>`. Asks herdr nothing; exits with pi's code.
 */
async function resumePi(): Promise<void> {
  const id = parsePiResume(rest).toLowerCase()
  const sleeper = Object.values(peekPiSleepers()).find(s => piSessionId(s.session).toLowerCase() === id)
  const file = sleeper?.session ?? findPiSession(id)
  if (!file) throw new Error(`no pi session ${id}: wake does not know it, and no pi session folder has its file`)
  const plan = piResumeArgv(sleeper?.argv ?? [], file)
  if ('error' in plan) console.error(`board resume --pi: ${plan.error}; pi starts with --session only`)
  const [program = 'pi', ...argv] = 'argv' in plan ? plan.argv : ['pi', '--session', file]
  const env = piResumeEnv(process.env, sleeper?.account, homedir())
  const cwd = sleeper?.cwd && statSync(sleeper.cwd, { throwIfNoEntry: false })?.isDirectory() ? sleeper.cwd : undefined
  const ran = await runHere(program, argv, env, cwd)
  if (ran.error) throw new Error(`${program} did not start: ${messageOf(ran.error)}`)
  process.exit(ran.code)
}

/**
 * `board tg-key`: the key claude-tg puts in TG_KEY (#119), as herdr-wake's tg-key.mjs printed it:
 * the Telegram topic of this pane's tab from one `herdr api snapshot` (5 s at most) when
 * HERDR_PANE_ID is set, else, or when herdr does not answer, this folder. Prints it; never fails.
 */
async function tgKey(): Promise<void> {
  const pane = process.env.HERDR_PANE_ID || undefined
  let snap: TopicSnapshot | null = null
  if (pane) {
    try {
      snap = asSnapshot(await herdr(['api', 'snapshot'], 5000))
    } catch {}
  }
  console.log(keyFor(snap, pane, process.cwd()))
}

/**
 * Where `board resume` runs Claude (core/resume.ts resumeDir, spec call 29): null, this folder,
 * when the session's transcript is under the profile's projects/ for it (a pane herdr restored);
 * else the folder the transcript recorded, found in the profile `dir`'s projects/, when it still
 * is one. Found nowhere, not to be read, or a profile folder that would be another one there:
 * null, as before.
 */
async function resumeFolder(session: string, dir: string): Promise<string | null> {
  try {
    const cwd = process.cwd()
    const here = join(dir, 'projects', projectFolderName(cwd), `${session}.jsonl`)
    const transcriptHere = !!statSync(here, { throwIfNoEntry: false })?.isFile()
    // Else the first projects/*/<id>.jsonl.
    const file = transcriptHere ? null : createClaudeHome(dir).transcriptPath(session, cwd)
    const recorded = file ? await cwdOf(file) : null
    const to = resumeDir({
      cwd,
      transcriptHere,
      recorded,
      recordedExists: !!recorded && !!statSync(recorded, { throwIfNoEntry: false })?.isDirectory(),
    })
    // Claude reads its profile folder from the folder it starts in: one named from this folder (a
    // relative CLAUDE_CONFIG_DIR, or on Windows `\…` without its drive) may be another one there.
    return to && resolve(to, dir) === resolve(cwd, dir) ? to : null
  } catch {
    return null
  }
}

/**
 * `board archive --session <id|name|pane>`: another session off the board, by the same rules as
 * the web board's "Archive" (free: no turn, no dialog, no text in its input box, no background
 * command; its profile one the board can tell, its registry read in that profile), its pane
 * closed right away rather than after the page's undo time. The user brings it back from the
 * board's archive. In English for agents, whatever language the board speaks.
 */
async function archive(): Promise<void> {
  if (!target)
    throw new Error(
      'usage: board archive --session <id|name|pane>: the session to take off the board (one you started, or one the user asked you to)',
    )
  // Its helpers too: one with helpers at work stays, as on the web board.
  const items = await collect(deps, { helpers: true })
  const want = target.toLowerCase()
  const is = (i: Item, fields: readonly ('key' | 'session' | 'pane' | 'name' | 'autoName')[]): boolean =>
    fields.some(f => {
      const v = i[f]
      return !!v && String(v).toLowerCase() === want
    })
  // An id or a pane says which one exactly; a name may fit several, and then none is taken.
  let found = items.filter(i => is(i, ['key', 'session', 'pane']))
  if (!found.length) found = items.filter(i => is(i, ['name', 'autoName']))
  if (found.length > 1)
    throw new Error(
      `"${target}" fits ${found.length} sessions on the board (${found.map(i => `${i.name} in ${i.pane}`).join(', ')}); give its session id or pane`,
    )
  const item = found[0]
  if (!item) throw new Error(`no session "${target}" on the board`)
  const from = await ownSession()
  if (from?.key === item.key)
    throw new Error(
      'a session cannot archive itself: its turn is on while it asks. Tell the user it is done, or let the session that started it archive it',
    )
  const en = translator('en')
  const lower = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`
  const r = await askArchive(deps, item, { by: 'agent', from, grace: 0, tr: en })
  if (!r.ok)
    throw new Error(`${item.name} stays on the board: ${lower(en(r.why, { name: item.name, why: r.detail ?? '' }))}`)
  // Closed here and now; a board's scheduler that gets to it first does the same.
  const { closed } = await closeDue(deps, { keys: [item.key] })
  if (!getArchived(item.key)) {
    // Called off at the last moment: the session got to work, or herdr would not close it.
    const kept = readArchiveLog(20).find(e => e.key === item.key && e.result === 'kept')
    // The log says a profile's doubt in the board's language (the page reads it): told anew here.
    const detail =
      kept?.why === 'archive.why.profile'
        ? (profileDoubt(item, deps.profiles(), en) ?? kept.detail ?? '')
        : (kept?.detail ?? '')
    const why = kept ? en(kept.why ?? '', { why: detail }) : 'it is not in the archive'
    throw new Error(`${item.name} stays on the board: ${lower(why)}`)
  }
  const held = r.held ? ` · ${r.held} schedule ${r.held === 1 ? 'entry waits' : 'entries wait'} with it` : ''
  const state = closed ? 'its pane is closed' : 'its pane closes in a moment'
  console.log(
    `ok · archived ${item.name}: ${state}; the user can bring it back from the board's archive (Archive on the toolbar)${held}`,
  )
}

// What holds a session up, for `board sleep`'s lines.
const KEPT: Record<string, string> = {
  busy: 'working',
  dialog: 'a dialog waits for an answer',
  draft: 'unsent text in its input box',
  tasks: 'background tasks run',
  gone: 'another session is in its pane now',
}

/** Why a session stays up, naming the wake that puts sessions to sleep where it is the reason. */
function keptBy(o: SleepOutcome): string {
  if (o.why === 'refused') return `${wakeName()} refused: ${o.detail ?? ''}`
  if (o.why === 'notClaude') return `not a Claude session, and ${wakeName()} puts only those to sleep`
  return KEPT[o.why ?? ''] ?? o.detail ?? ''
}

/** One session's line: who, then asleep, or why it stays up. */
function sleepLine(o: SleepOutcome): string {
  const who = o.name ? `${o.name}${o.pane ? ` (${o.pane})` : ''}` : `"${o.target}"`
  const held = keptBy(o)
  if (o.result === 'asleep') return `${who}: asleep`
  if (o.result === 'already') return `${who}: asleep already`
  if (o.result === 'scheduled')
    return `${who}: ${held}; goes to sleep once it is free${o.again ? ' (asked before)' : ''} · cancel: board unschedule ${o.id}`
  if (o.why === 'unknown') return `${who}: no such session on the board`
  if (o.why === 'ambiguous') return `${who}: fits several sessions (${o.detail}); give its session id or pane`
  return `${who}: kept up, ${held}`
}

/**
 * `board sleep <id|name|pane>... [--when-free] [--self]`: several sessions put to sleep at once
 * (services/sleep.ts), for a session that coordinates others; a line for each. `--self` adds the
 * session running it, found as `board doing` finds it, always once it is free: it is in a turn
 * now. Refused at once without herdr-wake, which puts them to sleep. In English for agents,
 * whatever language the board speaks (but for what herdr-wake and the profile guard say).
 */
async function sleep(): Promise<void> {
  if (piSessionFile !== undefined) return adoptPi()
  const targets = [...rest, ...(target ? [target] : [])]
  if (!targets.length && !self)
    throw new Error(
      'usage: board sleep <id|name|pane>... [--when-free] [--self]: the sessions to put to sleep (a name with spaces in quotes; --self: this one, once its turn is over)',
    )
  const up = await wakeAnswers(deps)
  if (!up.ok) throw new Error(`putting sessions to sleep needs ${wakeMissing(up)}; nothing was put to sleep`)
  const from = await ownSession()
  if (self && !from)
    throw new Error(
      'board sleep --self is for the session running it, and this is none: run it from a Claude session in herdr; nothing was put to sleep',
    )
  const items = await collect(deps)
  let others = targets
  if (self && from) {
    const me = sessionsFor(items, from.key)
    if (!me.length)
      throw new Error(`board sleep --self: this session (${from.key}) is not on the board; nothing was put to sleep`)
    // A target that names it too goes with --self, once it is free, not as one more line.
    others = targets.filter(t => {
      const fits = sessionsFor(items, t)
      return !(fits.length === 1 && me.some(m => m.key === fits[0]?.key))
    })
  }
  const results = [
    ...(others.length ? await sleepMany(deps, items, others, { whenFree, by: 'agent', ...(from && { from }) }) : []),
    // Itself last, so the others go first; its entry is its own, set by no other session.
    ...(self && from ? await sleepMany(deps, items, [from.key], { whenFree: true, by: 'agent' }) : []),
  ]
  // A session two targets name counts once.
  const each = [...new Map(results.map(o => [o.key ?? o.target, o.result])).values()]
  const count = (result: SleepOutcome['result']): number => each.filter(r => r === result).length
  const kept = count('kept')
  const head = [
    `${count('asleep')} put to sleep`,
    count('already') && `${count('already')} asleep already`,
    count('scheduled') && `${count('scheduled')} once free`,
    kept && `${kept} kept up`,
  ]
  // Held for what passes: --when-free would have them sleep once it is over.
  const hint =
    !whenFree && results.some(o => o.result === 'kept' && ['busy', 'dialog', 'draft', 'tasks'].includes(o.why ?? ''))
      ? ' · with --when-free the busy ones go to sleep once they are free'
      : ''
  const note = count('scheduled') ? await schedulerNote() : ''
  console.log([`ok · ${head.filter(Boolean).join(', ')}${hint}${note}`, ...results.map(sleepLine)].join('\n'))
}

/**
 * `board sleep <pane> --pi-session <file>` (#178): a pane at its shell where a pi session was
 * stopped by hand, taken by the board's wake as that session asleep there: its card shows it
 * sleeping and wakes it, as if wake had put it to sleep. Only through the board's own wake.
 */
async function adoptPi(): Promise<void> {
  const pane = rest[0] ?? ''
  const file = piSessionFile ?? ''
  if (rest.length !== 1 || !pane || !isPiSessionFile(file))
    throw new Error(
      'usage: board sleep <pane> --pi-session <pi session file>: the pane, a shell now, and the file of the pi session that ran in it',
    )
  if (currentWakeMode(cfg).kind !== 'new')
    throw new Error(
      `taking a pi session as asleep needs the board's own wake, and ${wakeName()} answers here; nothing was done`,
    )
  const up = await wakeAnswers(deps)
  if (!up.ok) throw new Error(`taking a pi session as asleep needs ${wakeMissing(up)}; nothing was done`)
  const port = wakeConfig(cfg.wake).port
  const res = await fetch(`http://127.0.0.1:${port}/sleep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: pane, piSession: file }),
    signal: AbortSignal.timeout(30_000),
  })
  const body: unknown = await res.json().catch(() => null)
  if (!isRecord(body) || body.ok !== true)
    throw new Error(
      `${pane} stays as it is: ${String((isRecord(body) && body.error) || `wake answered ${res.status}`)}`,
    )
  console.log(
    `ok · ${String(body.name)} (pi) is asleep in ${pane}${body.already ? ' already' : ''}: its card shows it sleeping; Wake, a message or a reminder wakes it`,
  )
}

/**
 * `board remote [on | off | pwa on|off | approve <id> | deny <id> | revoke <id>]`: the remote mode
 * (core/remote.ts). On and off edit config.json (off takes back `tailscale serve` too); `pwa`
 * sets serve up for the board in a phone's browser (core/pwa.ts) and shows its address and QR
 * code; the rest goes through the running board, which holds the requests to pair. Without an
 * argument: where it listens, who waits, who is paired.
 */
async function remote(): Promise<void> {
  const [op = 'status', id = ''] = rest
  const usage = 'usage: board remote [on | off | pwa on|off | approve <id> | deny <id> | revoke <id>]'
  const webPort = Number(cfg.port) || 12422
  if (op === 'pwa') {
    const { pwaOff, pwaOn } = await import('../services/pwa.ts')
    if (id === 'off') {
      const r = await pwaOff(cfg, webPort)
      if (!r.ok) throw new Error(r.error)
      return console.log("ok · the board in a phone's browser is off; tailscale serve no longer forwards to it")
    }
    if (id !== 'on') throw new Error(usage)
    const r = await pwaOn(cfg, webPort)
    if (!r.ok) throw new Error(r.error)
    const { qrMatrix, qrText } = await import('../core/qr.ts')
    console.log(`ok · on a phone with Tailscale, open ${r.url}`)
    console.log(qrText(qrMatrix(r.url)))
    return console.log('Approve the phone in Settings → Phones… on the web board, or with `board remote approve <id>`.')
  }
  if (op === 'on' || op === 'off') {
    let r: { ok: true } | { ok: false; error: string }
    if (op === 'on') r = setRemoteOn(true)
    else r = await (await import('../services/pwa.ts')).remoteOff(cfg, webPort)
    if (!r.ok) throw new Error(r.error)
    return console.log(
      op === 'on'
        ? 'ok · remote on: the board listens on its Tailscale address in a few seconds; `board remote` says where'
        : 'ok · remote off',
    )
  }
  const url = `http://127.0.0.1:${webPort}/api/remote`
  const call = async (init?: RequestInit): Promise<unknown> => {
    try {
      return await (await fetch(url, { ...init, signal: AbortSignal.timeout(3000) })).json()
    } catch {
      throw new Error('the board does not run: open it first (herdr plugin action invoke agent-board.open)')
    }
  }
  if (op === 'approve' || op === 'deny' || op === 'revoke') {
    if (!id) throw new Error(usage)
    const body = JSON.stringify({ op, id })
    const r = await call({ method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body })
    if (!isRecord(r) || r.ok !== true) throw new Error(`no request or device ${id}: \`board remote\` lists them`)
    return console.log(`ok · ${op === 'approve' ? 'approved' : op === 'deny' ? 'denied' : 'revoked'} ${id}`)
  }
  if (op !== 'status') throw new Error(usage)
  const view = (await call()) as Partial<RemoteView>
  if (!view.on) return console.log('remote off · `board remote on` lets a paired phone use this board over Tailscale')
  console.log(`remote on · ${view.url ?? `not listening: ${view.error ?? 'starting'}`}`)
  const pwa = view.pwa
  if (pwa?.on)
    console.log(
      `in a phone's browser · ${pwa.url ?? (pwa.error || (pwa.serve === 'other' ? 'serve forwards the port elsewhere' : 'tailscale serve does not forward to it: board remote pwa on'))}`,
    )
  for (const r of view.pending ?? [])
    console.log(
      `asks to pair: ${r.id} "${r.name}" from ${r.device} (${[r.login, r.os].filter(Boolean).join(', ')}) · board remote approve ${r.id}`,
    )
  for (const d of view.devices ?? [])
    console.log(
      `paired: ${d.id} "${d.name}"${d.kind === 'browser' ? ' (browser)' : ''} on ${d.device} (${d.login})${d.seenAt ? `, seen ${stamp(d.seenAt)}` : ''}`,
    )
}

const NO_BOARD = 'the board does not run: open it first (herdr plugin action invoke agent-board.open)'
const TUNNEL_OFF = 'tunnel off · Settings → Remote access… on the web board sets it up'
/** A time of today for the tunnel's lines: 14:02, or 14:02:07. */
const clock = (ms: number, seconds = false): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
}

const STEP_IDS: ReadonlySet<unknown> = new Set(['ssh', 'forward', 'domain'])
const isStep = (v: unknown): v is TestStep =>
  isRecord(v) &&
  STEP_IDS.has(v.id) &&
  (v.ok === null || typeof v.ok === 'boolean') &&
  typeof v.detail === 'string' &&
  (v.hint === null || typeof v.hint === 'string')

/**
 * `board tunnel [on | off | test]`: the board through the owner's own domain (core/tunnel.ts). On
 * and off edit config.json, and the running board follows; on refuses while the settings do not
 * check out or the password and the code are not set up (that needs a screen: the web board's
 * Remote access…). Test runs Test connection on the running board. Without an argument: where the
 * tunnel stands, as the running board says. In English, whatever language the board speaks.
 */
async function tunnel(): Promise<void> {
  const [op = 'status'] = rest
  const webPort = Number(cfg.port) || 12422
  // The settings' checks speak the board's language; this command speaks English.
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  const conf = tunnelConfig(cfg.tunnel)
  /** Why the tunnel cannot run now: the first setting that does not check out, or the login not set up; null when it can. */
  const blocked = async (): Promise<string | null> => {
    const problem = tunnelProblems(conf, boardPorts(cfg.remote, webPort))[0]
    if (problem) return problem.message
    const { accessReady } = await import('../adapters/access-store.ts')
    return accessReady() ? null : 'Set up the password and the code first: Settings → Remote access… on the web board'
  }
  if (op === 'on') {
    const why = await blocked()
    if (why) throw new Error(why)
    const r = setTunnelOn(true)
    if (!r.ok) throw new Error(r.error)
    return console.log('ok · tunnel on: the board opens it in a few seconds; `board tunnel` says how it stands')
  }
  if (op === 'off') {
    const r = setTunnelOn(false)
    if (!r.ok) throw new Error(r.error)
    return console.log('ok · tunnel off')
  }
  if (op === 'test') return tunnelTest(webPort, conf.domain ? publicOrigin(conf) : '')
  if (op !== 'status') throw new Error('usage: board tunnel [on | off | test]')
  const { boardAccessView } = await import('../services/tunnel-facts.ts')
  const view = await boardAccessView(webPort)
  if (!view) return console.log(conf.on ? 'tunnel on · the board does not run' : TUNNEL_OFF)
  const { settings, status: s, ssh } = view.tunnel
  if (!settings.on) return console.log(TUNNEL_OFF)
  const lines = [`tunnel ${s.state} since ${clock(s.since)}${settings.domain ? ` · ${publicOrigin(settings)}` : ''}`]
  // on, and the board has not started it: what holds it, as `board tunnel on` would say
  const why = s.state === 'off' ? await blocked() : null
  if (why) lines.push(`not started: ${why}`)
  if (s.state === 'reconnecting')
    lines.push(`attempt ${s.attempt ?? 1}, next try ${clock(s.nextAt ?? s.since, true)}: ${s.error ?? ''}`)
  if (s.state === 'error') {
    lines.push(`error: ${s.error ?? ''}`)
    if (s.hint) lines.push(`fix: ${t(`tunnel.hint.${s.hint}`)}`)
  }
  if (s.probe && !s.probe.ok) lines.push(`warning: the domain did not reach this board: ${s.probe.detail}`)
  lines.push(`socket ${settings.socket} · ssh ${ssh ?? 'not found'}`)
  console.log(lines.join('\n'))
}

/** What `board login link` says when a login is set already, on stderr: stdout is for the link alone. */
const LOGIN_SET = 'a login is set: `board login reset` clears it and prints a new link'

/**
 * `board login [link | reset]` on the board's own server (core/on-server.ts, services/first-login.ts):
 * the first login's one-time link on stdout, alone on its line, for the installer to show. link
 * makes a fresh code while no login is set, and exits with 3 when one is; reset clears the
 * password, the code and the passkeys, has the running board end every login, and prints a new
 * link. Both refuse on a PC (exit 1). In English, whatever language the board speaks.
 */
async function login(): Promise<void> {
  const [op = ''] = rest
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  if (op !== 'link' && op !== 'reset') throw new Error('usage: board login [link | reset]')
  const mode = serverModeOf(cfg.serverMode)
  if (!mode) throw new Error('board login is for the board on its own server: config.json has no serverMode')
  const problem = serverModeProblems(mode)[0]
  if (problem) throw new Error(`serverMode.${problem.field}: ${problem.message}`)
  const { accessReady } = await import('../adapters/access-store.ts')
  const { newSetupLink, resetLogin } = await import('../services/first-login.ts')
  if (op === 'link') {
    if (accessReady()) {
      console.error(`board: ${LOGIN_SET}`)
      process.exitCode = 3
      return
    }
    return console.log(newSetupLink(mode.domain))
  }
  const answered = await resetLogin(Number(cfg.port) || 12422)
  console.error(
    `ok · the password, the code and the passkeys cleared, every login ended${answered ? '' : ' (the board does not run)'}; the link below sets a new login`,
  )
  console.log(newSetupLink(mode.domain))
}

/** `board tunnel test`: Test connection on the running board, a line for each step; one that failed exits with 1. `origin`: the domain's ('' for none). */
async function tunnelTest(webPort: number, origin: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'test' }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new Error('Test connection took longer than 60 s')
    throw new Error(NO_BOARD)
  }
  const body: unknown = await res.json().catch(() => null)
  const given: unknown[] = isRecord(body) && body.ok === true && Array.isArray(body.steps) ? body.steps : []
  const steps = given.filter(isStep)
  if (!steps.length || steps.length !== given.length)
    throw new Error(String((isRecord(body) && body.error) || `the web board answered ${res.status}`))
  const label: Record<TestStep['id'], string> = {
    ssh: 'ssh and the key',
    forward: 'the server takes the forward',
    domain: origin ? `through ${origin}` : 'through the domain',
  }
  const lines: string[] = []
  for (const step of steps) {
    const mark = step.ok === true ? '✓' : step.ok === false ? '✗' : '–'
    // a detail the label says already (the domain) is left out
    const detail = step.detail && !label[step.id].includes(step.detail) ? `: ${step.detail}` : ''
    lines.push(`${mark} ${label[step.id]}${detail}`)
    if (step.ok === false && step.hint) lines.push(`  ${t(`tunnel.hint.${step.hint}`)}`)
  }
  console.log(lines.join('\n'))
  if (steps.some(step => step.ok === false)) process.exitCode = 1
}

/**
 * A MokuPilot call's results for the session it was a fork of (MokuPilot runs this once its
 * protocol is ready, from outside any pane): queued as a schedule entry of kind 'call', due now
 * and sent once the session is free, so it never cuts into a turn; a sleeping session is woken,
 * and with no board running it goes out once one runs. The scheduler frames it as information
 * (core/schedule-rules.ts promptOf), not as work to start. With --report-id it is retry-safe
 * (adapters/call-receipts.ts): the answer is its receipt as JSON, and the same report again is
 * that receipt, not another entry; --status shows the receipt.
 */
async function callReport(): Promise<void> {
  const usage = 'usage: board call-report --session <Claude session id> --file <report.md>'
  if (!target || !UUID.test(target)) throw new Error(`${usage}; the session id is a UUID`)
  const session = target
  const ri = rest.indexOf('--report-id')
  const reportId = ri >= 0 ? rest[ri + 1] : null
  if (ri >= 0 && (!reportId || reportId.startsWith('--'))) throw new Error('missing report-id')
  if (reportId) reportIdentity(session, reportId)
  if (rest.includes('--status')) {
    if (!reportId) throw new Error('--status requires --report-id')
    const receipt = getReceipt(session, reportId)
    if (!receipt) throw new Error('no receipt for this session and report-id')
    return printReceipt(receipt)
  }
  const fi = rest.indexOf('--file')
  const file = fi >= 0 ? (rest[fi + 1] ?? '') : ''
  if (!file) throw new Error(usage)
  let report: string
  try {
    report = reportId ? readReport(file) : readFileSync(file, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    throw new Error(`cannot read the report ${file}: ${e.code || e.message}`)
  }
  report = report
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!report) throw new Error(`the report ${file} is empty`)
  const contentHash = reportHash(report)
  if (report.length > MAX_REPORT) {
    const note = `\n\n[the report goes on; all of it: ${file}]`
    report = `${report.slice(0, MAX_REPORT - note.length).trimEnd()}${note}`
  }
  // The board's own idea of the session, when herdr answers: its name for the schedule, and its
  // pane and folder, which find it again after /clear.
  let item: Item | null = null
  try {
    item = (await collect(deps)).find(i => i.key === session || i.session === session) ?? null
  } catch {}
  // Else its name in Claude's registry. MokuPilot runs this from its own env, so not only this
  // env's profile: the session may run in any profile listed, a hidden one too.
  const name =
    item?.name ?? deps.homes.liveSessions(deps.profiles().list.map(p => p.dir)).get(session)?.session.name ?? ''
  const now = Date.now()
  const fields: NewEntry = {
    key: reportId ? session.toLowerCase() : (item?.key ?? session),
    name,
    ...(item?.pane && { pane: item.pane }),
    ...(item?.cwd && { cwd: item.cwd }),
    kind: 'call',
    idle: true,
    text: report,
    at: now,
    next: now,
    by: 'mokupilot',
  }
  if (reportId) {
    const identity = reportIdentity(session, reportId, contentHash)
    const receipt = enqueueReport(identity, {
      findEntry: key => listEntries().find(e => isRecord(e.receipt) && e.receipt.key === key),
      createEntry: receipt => addEntry({ ...fields, receipt }),
    })
    return printReceipt(receipt)
  }
  const e = addEntry(fields)
  console.log(
    `ok · call report ${e.id} for ${name || session.slice(0, 8)}, typed in once the session is free · cancel: board unschedule ${e.id}${await schedulerNote()}`,
  )
}

/** A retry-safe report's receipt, as JSON; delivery under way or not known exits with 2: do not replay. */
function printReceipt(receipt: Receipt): void {
  console.log(
    JSON.stringify({
      reportId: receipt.reportId,
      session: receipt.session,
      entryId: receipt.entryId,
      state: receipt.state,
      reused: !!receipt.reused,
    }),
  )
  if (receipt.state === 'delivery-unknown' || receipt.state === 'dispatching') process.exitCode = 2
}

main().catch((err: unknown) => {
  console.error(`board: ${messageOf(err)}`)
  process.exit(1)
})
