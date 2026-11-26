// `board`: how agents keep their card current. Prints one line, so a call costs next to nothing.
//   board                    show this session's card
//   board cat <id> [title]   set the category (lane); a new id with a title is added to the config
//   board doing <text>       what the session works on now
//   board wait <text>        what it waits for outside the chat (moves the card to "waiting")
//   board wait <text> --probe "<command>" [--every 10m] [--timeout 20s] [--silence 3d]
//                            with `watches` on in config.json: the board runs the command on the
//                            interval with no model and wakes the session when it exits 0
//                            (entrypoints/watch-cli.ts); doing, done, clear or a new wait end it
//   board ask <question>     needs the user: "Needs me" until the user's next prompt; while
//                            config.json turns decisions on (#487), also --option "<label>" (2 to
//                            4), --recommend <n>, --default-after <30m|2h> (needs --recommend)
//   board decisions [--done] what waits on the owner across lanes (decisions on), or the last
//                            ones closed
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
//   board schedule [--all]   this session's entries (every session's); those parked with an
//                            archived session too, marked (--session finds one by its name or pane)
//   board schedule --move <id>   moves an entry parked with an archived session to this session
//                            (or --session's), into the schedule as Return would put it back
//   board unschedule <id|all>    removes an entry, a parked one too (all: every entry of this session)
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
//   board move <id|name|pane>... --device <id|local>   moves those sessions to another device
//                            through the running master board (#616, services/nodes/move-device.ts);
//                            --dry-run lists what would go, the uncommitted changes among it
//   board move <id|name|pane>... --profile <id> [--when-free]   moves those sessions to another
//                            Claude profile, keeping their conversation (#250, services/move.ts): put
//                            to sleep first when free (--when-free: the busy ones once they are),
//                            their conversation copied there, card and wake switched; a line each
//   board fork [--name <Name>] [note]   a fork of this session (or --session's): a new session in
//                            a new tab with a copy of its conversation, started by the web board as
//                            its Fork does (services/launch/fork.ts); the note is its first message
//   board tunnel [on|off|test]   the board through the owner's own domain (core/tunnel.ts): where
//                            the tunnel stands; on and off in config.json; test runs Test connection
//   board node [token [--name <master>] | forget <id> | leave [<master id>]]   this board as a node
//                            (#498): its master door (server/node-listener.ts), on or off, its port
//                            and its masters by name and when last seen; token adds a master and
//                            prints its token once; forget takes one's token back; leave is the
//                            node's half of a revoke (#510): one master forgotten, or the only one.
//                            Until the install exists, for a node set up by hand; a board without
//                            `node` in config.json says it is none
//   board nodes [token <id> | key <id> | sync <id> [<profile>] | update <id> | secret <id> <sink> | revoke <id> [--keep-running] [--forget]]   this board as a
//                            master (#499): its devices in order with their link's state, read from
//                            the running board; token stores a device's token read from stdin (never
//                            an argument, never echoed); key makes the device's ssh link key when
//                            missing and prints its public half; sync makes the device's profile
//                            bundle current now (#506); secret gives one of the device's sinks its
//                            values, each read from the terminal without echo (#507); revoke marks
//                            the device revoked and tells the node to sleep its sessions and forget
//                            this board, now or when it is back; --forget drops its token and key
//                            now without telling it (#510)
//   board doctor             what is set up on this computer, and what is missing (core/setup.ts)
//   board update             the board's update of itself from git (#617) now, through the running
//                            web board, whether or not Settings → Updates… turns it on: says what it
//                            did or why it skipped, and after an update waits for the board to come
//                            back on the new commit
//   board presence [here|away|call]   whether the user is at the computer, away or on a call
//                            (core/presence.ts), the line every session's context has; with a
//                            state, the user's switch
//   board away [on|off]      the same switch: away (on, the default) or back at the computer (off).
//                            Both only while config.json turns presence on; never sent to a session
//   board journal [--since <when> | --away] [--json]   what changed on the board since the owner
//                            left (#489, entrypoints/journal-cli.ts), while config.json has `journal`
//   board ns-sessions list [--json]   the NetSuite session store's entries (#860,
//                            entrypoints/ns-sessions-cli.ts): metadata only, never a cookie value
//   board secret request --title <what for> --sink <id> [--field <name>[:shown][:once]]...
//                            [--param <name>=<value>]... [--expires 30m] [--no-wait]
//                            asks the owner for values the agent must never see (#273,
//                            entrypoints/secret-cli.ts): the owner fills a form on the board, the
//                            board writes the sink config.json defines; waits, then prints ok,
//                            declined or expired. status <id> [--wait] | cancel <id> | list | sinks
//   board todo add [--mine] [--ref <r>] [--why <w>] "<text>" | done <key> [--why <w>] | list
//                            tasks (#202, core/todos.ts): what the agent hands the user to do, or
//                            (--mine) a promise of its own it defers, printed with its key
//                            (<lane>-<session>-<n>, #319); done closes its own, and on the user's
//                            proposes it done for them to confirm (closes it with autoClose); list
//                            shows this session's open ones. Only while config.json turns tasks on
//                            with agents (`"todos": true`)
//   board compact [--at <300k|60%|never>] [--note "<what to keep>" | --note none] [--clear]
//                            auto-compact (#378, entrypoints/compact-cli.ts): once this session's
//                            context reaches the limit, the board types /compact into it between
//                            turns (with the instructions for its summary); never: not even
//                            Settings' default; --clear: Settings' default applies; no flags: shows it
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
//   board backup now | status | list [folder|server] | passphrase | folder <path> | folder off |
//                            test <folder|server>   the backup of the board's database (#233,
//                            services/backup.ts): a snapshot to every target now; how each stands;
//                            the snapshots a target holds; the passphrase (two lines on stdin, never
//                            an argument); the folder target; a real round trip to a target
//   board time add | edit | move | rm | restore | show | list | day | projects | import   time
//                            entries in the board's database (#233, entrypoints/time-cli.ts, where
//                            each is spelled out), written as this session, its lane the client
//   board cal list | sources | sync | add | edit | rm | push   the owner's calendar (#328,
//                            entrypoints/cal-cli.ts, where each is spelled out): every source's events,
//                            the board's own changed as this session; while config.json turns it on
//   board thread new | post | done | ask | set | show | list | changes | watch | unwatch | link | open | import
//                            threads (#379, entrypoints/thread-cli.ts, where each is spelled out):
//                            written as this session (or --session's), its watchers told in one line;
//                            while config.json turns them on
//   board db restore [--target folder|server] [--snapshot <name>] [--file <path>]
//                            [--passphrase-file <file> | --passphrase-stdin] [--replace-file]   the database back as a
//                            snapshot has it (the newest of the target when none is named); without
//                            a target, the snapshots each target holds
//   board db rekey --from <old> --to <new> [--dry-run] [--json]   rewrites master-relative session
//                            keys in board.db, schedule, watches and legacy move marks when the master
//                            changes devices (#696)
// --session <id|name|pane> targets another session's card (for coordinating sessions).

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
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
import { allCards, changeTodos, readCard, writeCard } from '../adapters/cards.ts'
import { createClaudeHome, cwdOf } from '../adapters/claude-home.ts'
import { noDaemonArgs } from '../adapters/codex-flags.ts'
import { codexHomeOf } from '../adapters/codex-home.ts'
import {
  configFile,
  editCategories,
  loadConfig,
  setRemoteOn,
  setRemoteOwnerAdmin,
  setTunnelOn,
} from '../adapters/config-file.ts'
import { cygpath, takeGitBashArgs } from '../adapters/git-bash.ts'
import { asSnapshot, type HerdrPane, herdr, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { readMasterFlags } from '../adapters/master-flags-store.ts'
import { ownerServices } from '../adapters/owner-services.ts'
import { findPiSession } from '../adapters/pi-home.ts'
import { currentPresence, setPresence } from '../adapters/presence-store.ts'
import { runHere } from '../adapters/process.ts'
import type { LiveHit } from '../adapters/profile-homes.ts'
import {
  addEntry,
  askRestart,
  endWatches,
  listEntries,
  listWatches,
  type NewEntry,
  removeEntry,
  removeWatch,
  schedulerRuns as schedulerRunsNow,
} from '../adapters/schedule-store.ts'
import { peekAgySleepers, peekPiSleepers, wakeCodexFile } from '../adapters/wake-files.ts'
import { AGY_AGENT, isAgyItem } from '../core/agy.ts'
import { formatListLines } from '../core/board-list.ts'
import { withBoardPaths } from '../core/board-paths.ts'
import { categoryFor, categoryInfo } from '../core/categories.ts'
import { CODEX_AGENT, isCodexItem, isCodexSession } from '../core/codex.ts'
import { DECISION_FLAGS, type DecisionView, decisionsConfig, masterHeld, orderQueue } from '../core/decisions.ts'
import { switchedOff } from '../core/feature-switch.ts'
import { translator } from '../core/i18n/translator.ts'
import { t, useLanguage } from '../core/lang.ts'
import { agyCommand, codexCommand } from '../core/launch/agents.ts'
import { withMasterFlags } from '../core/master-flags.ts'
import { parseMoveAny } from '../core/move-device.ts'
import { isKeptCall, UPLINK_REFUSED } from '../core/node-uplink.ts'
import { isNodeOnly, nodeConfig } from '../core/nodes.ts'
import { isOwnerServiceKey } from '../core/owner-services.ts'
import { isPiSessionFile, piSessionId } from '../core/pi.ts'
import { isPresenceState, type PresenceState, presenceConfig, presenceLine } from '../core/presence.ts'
import { type ProfileSet, profileSet, resolveProfileDir, sessionProfile } from '../core/profiles.ts'
import { deskSteps, type RemoteView, remoteConfig } from '../core/remote.ts'
import { parseResume, projectFolderName, resumeDir, resumePlan, resumeProfileId, withNodeEnv } from '../core/resume.ts'
import {
  clip,
  formatEveryOk,
  formatRemindOk,
  fromNow,
  parseEveryRest,
  parseRemindRest,
  scheduleParts,
  stamp,
  waitsPart,
} from '../core/schedule-cli.ts'
import { MAX_REPORT, promptOf, type ScheduleEntry, type SessionRef } from '../core/schedule-rules.ts'
import { findTodo, numberTodos, sortTodos, type Todo, todoKey, todosConfig, todosOf } from '../core/todos.ts'
import { boardPorts, publicOrigin, type TestStep, tunnelChecks, tunnelConfig, tunnelProblems } from '../core/tunnel.ts'
import type { Item } from '../core/types.ts'
import { agyResumeArgv, parseAgyResume } from '../core/wake/agy.ts'
import { wakeConfig } from '../core/wake/config.ts'
import { parsePiResume, piResumeArgv, piResumeEnv } from '../core/wake/pi.ts'
import { keyFor, type TopicSnapshot } from '../core/wake/topics.ts'
import { type WatchEntry, watchesConfig } from '../core/watches.ts'
import { scheduleZone } from '../core/when.ts'
import { checkWake, wakeAnswers, wakeSleepsAgy } from '../services/actions.ts'
import {
  askArchive,
  closeDue,
  dropHeld,
  dueAgain,
  getArchived,
  heldEntry,
  listArchive,
  moveHeld,
  profileDoubt,
} from '../services/archive.ts'
import { collect } from '../services/board.ts'
import { defaultDeps } from '../services/deps.ts'
import { type MoveOutcome, moveMany } from '../services/move.ts'
import { agyCallerOf, agySessionOf, codexCallerOf, codexSessionOf, ownSessionOf } from '../services/own-session.ts'
import { type SleepOutcome, sessionsFor, sleepMany } from '../services/sleep.ts'
import { currentWakeMode } from '../services/wake/mode.ts'
import { compactCli } from './compact-cli.ts'
import type { ThreadCmdContext } from './thread-cli.ts'

const USAGE = `board [cat <id> ["<Title>"] | doing <text> | wait <text> | ask <question> [--option "<label>"]... [--recommend <n>] [--default-after <30m|2h>] | decisions [--done] [--json] | done [text] | clear | favorite [off] | list | agents [--json] | cats | remind <when> "<text>" [--idle] | send <name|key> "<text>" | every "<cron>" "<text>" [--idle] | restart ["<note for after>"] | archive --session <id|name|pane> | sleep <id|name|pane>... [--when-free] [--self] | move <id|name|pane>... --profile <id> [--when-free] | move <id|name|pane>... --device <id|local> [--dry-run] | fork [--name "<Name>"] ["<note>"] | schedule [--all | --move <id>] | unschedule <id|all> | call-report --session <id> --file <report.md> [--report-id <stable-id>] | remote [on | off | pwa on|off | owner-admin on|off | approve <id> | deny <id> | revoke <id> | desk <id> [off]] | tunnel [on | off | test] | node [token [--name <master>] | forget <id> | leave [<master id>]] | nodes [token <id> | key <id> | sync <id> [<profile>] | update <id> | secret <id> <sink> | revoke <id> [--keep-running] [--forget]] | master [handover --to <device> [--dry-run] [--reverse-link <spec>] [--node-port <port>] [--allow-offline-nodes] [--json] | rollback [--id <id>] [--local-only] [--discard-since-commit] [--json] | status [--json]] | doctor | update | housekeeping [--dry-run | status] [--json] | presence [here | away | call] | journal [--since <when> | --away] [--json] | ns-sessions list [--json] | spend [--day <d>] [--lane <id>] [--json] | team join <invite> --hub <ws://host:7443> --name <name> | team roster | team draft <name|peer-id> "<text>" | team post <name|peer-id|team> [--new "<title>"] [--link <url>] "<text>" | team reply <thread> "<text>" | team thread <thread> | team assign <thread> <session> | team release <thread> | team listen [off] | team loop <name|peer-id|team> [<1-100>|default] | team channel delete <ref> | team channel leave <ref> | todo add [--mine] [--ref <r>] [--why "<w>"] "<text>" | todo done <key> [--why "<w>"] | todo list | compact [--at <300k|60%|never>] [--note "<what to keep>" | --note none] [--clear] | away [on | off] | resume <session id> [--profile <id>] | resume --pi <pi session id> | resume --agy <conversation id> | resume --codex <conversation id> | secret request --title "<what for>" --sink <id> [--field <name>[:shown][:once]]... [--param <name>=<value>]... [--expires 30m] [--no-wait] | secret status <id> [--wait] | secret cancel <id> | secret list | secret sinks | cal list [--day <d> | --from <t> --to <t>] [--json] | cal add|edit|rm|sources|sync|push (board cal --help) | thread new|post|done|ask|set|show|list|changes|watch|unwatch|link|open|import|share (board thread --help) | workdesk workers link|unlink|complete|incomplete | mcp [--agents | --http] | backup now|status|list|passphrase|folder <path>|test <target> | db restore [--target <t>] [--snapshot <name>] [--file <path>] | db rekey --from <old> --to <new> [--dry-run] [--json]] [--session <id|name|pane>]`
/** The commands that print a help of their own for `--help` (#305). */
const OWN_HELP: ReadonlySet<string> = new Set(['thread', 'time', 'cal', 'spend'])

/**
 * `board <command> --help` (#305): the usage's alternatives for that command, one a line; all of
 * the usage for a command it does not name.
 */
/** `board wait`'s watch flags (#486), in the usage only while config.json turns watches on. */
const WATCH_FLAGS = '[--probe "<command>" [--every 10m] [--timeout 20s] [--silence 3d]]'
/** The usage line as this board has it: with the watch flags while watches are on, else as before. */
const usageText = (): string =>
  watchesConfig(gate.watches) ? USAGE.replace('| wait <text> |', `| wait <text> ${WATCH_FLAGS} |`) : USAGE

function usageOf(command: string): string {
  const usage = usageText()
  const inner = usage.slice(usage.indexOf('[') + 1, usage.lastIndexOf('] [--session'))
  const alternatives: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '[') depth++
    else if (inner[i] === ']') depth--
    else if (depth === 0 && inner.startsWith(' | ', i)) {
      alternatives.push(inner.slice(from, i))
      from = i + 3
    }
  }
  alternatives.push(inner.slice(from))
  const own = alternatives.filter(a => a.split(' ')[0] === command)
  return own.length ? own.map(a => `usage: board ${a}`).join('\n') : usage
}

// Everything after the first `--` is the command's own words, as they are (#404): neither the
// board's flags below nor --help are read there. Started by the sh shim under Git Bash
// (core/install-plan.ts GIT_BASH_PATHS, #532), the arguments came as typed, so a text that starts
// with / stays itself; the file and folder words are converted here (core/board-paths.ts), as Git
// Bash did, and neither of the shim's variables goes on to what the board starts.
const argv = takeGitBashArgs() ? withBoardPaths(process.argv.slice(2), cygpath) : process.argv.slice(2)
const dashes = argv.indexOf('--')
const args = dashes < 0 ? argv : argv.slice(0, dashes)
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
// `board -- x` is no command, as before: not the bare `board`.
const [cmd = dashes < 0 ? 'show' : '--', ...flagWords] = args
/** The command's words, the `--` kept for the parsers that read it themselves (thread, time, cal). */
const rest = dashes < 0 ? flagWords : [...flagWords, ...argv.slice(dashes)]
/** The same without that `--`: what this file's commands take as their words and text. */
const words = dashes < 0 ? flagWords : [...flagWords, ...argv.slice(dashes + 1)]
const text = words.join(' ').replace(/\s+/g, ' ').trim()
/** `board <command> --help` or `-h`, a word of its own before any `--` (#305). */
const helpAsked = flagWords.includes('--help') || flagWords.includes('-h')
const cfg = loadConfig()
const deps = defaultDeps(cfg)
/**
 * What this board's gates read (#775): the config, and on a node the card-level features its master
 * has on (watches, tasks, decisions; core/master-flags.ts), which run here for this computer's
 * sessions. Without `node` it is `cfg` itself and nothing more is read. Never written back.
 */
const gate = withMasterFlags(cfg, nodeConfig(cfg.node) ? readMasterFlags() : null)
/** The owner's zone for the schedule's times (#806, core/when.ts scheduleZone); undefined: this computer's. */
const zone = scheduleZone(cfg.time)

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

// Which session this is (#488): one reading with spawn-agent --thread, services/own-session.ts.
/** A real Claude child has a new id; a root Codex can carry the Claude id its hook recorded. */
const codexCaller = (): boolean => codexCallerOf(process.env, readCard)

/** A Codex child inherits its parent's pane env; only the reported root session owns its card. */
function codexSession(p: HerdrPane | undefined): (Session & { name: string }) | null {
  return codexSessionOf(p, process.env)
}
const agyCaller = (): boolean => agyCallerOf(process.env, readCard)
function agySession(p: HerdrPane | undefined): (Session & { name: string }) | null {
  return agySessionOf(p, process.env, id => deps.agy.rootSession(id))
}
/**
 * The sessions running in every profile listed, hidden ones too, this env's own folder first (its
 * answer wins), as the board reads them (services/board.ts collect).
 */
const liveSessions = (): Map<string, LiveHit> => {
  const profiles = deps.profiles()
  return deps.homes.liveSessions([profiles.inheritedDir, ...profiles.list.map(p => p.dir)])
}

/**
 * { key, cwd } of the session the command is about. `archived`: a --session name or pane that
 * no session on the board has may be an archived one's (its entries wait in its record).
 */
async function resolveSession({ archived = false }: { archived?: boolean } = {}): Promise<Session> {
  if (target) {
    if (UUID.test(target)) return { key: target, cwd: '' }
    const t = target.toLowerCase()
    const item = (await collect(deps)).find(i =>
      [i.name, i.autoName, i.pane, i.session].some(v => v && v.toLowerCase() === t),
    )
    if (item) return { key: item.key, cwd: item.cwd, name: item.name, pane: item.pane }
    const r = archived
      ? listArchive().find(x => [x.name, x.autoName, x.pane, x.session, x.key].some(v => v && v.toLowerCase() === t))
      : undefined
    if (!r) throw new Error(`no session "${target}" on the board${archived ? ' or in its archive' : ''}`)
    return { key: r.key, cwd: r.cwd, name: r.name }
  }
  const pane = process.env.HERDR_PANE_ID
  const fromCodex = codexCaller()
  const fromAgy = !fromCodex && agyCaller()
  let reported: HerdrPane | undefined
  if (fromCodex && pane) {
    reported = await paneOf(pane)
    const codex = codexSession(reported)
    if (codex) return codex
  }
  if (fromAgy && pane) {
    reported = await paneOf(pane)
    const agy = agySession(reported)
    if (agy) return agy
  }
  const own = process.env.CLAUDE_CODE_SESSION_ID
  if (isOwnerServiceKey(own)) {
    const service = ownerServices().find(s => s.key === own)
    if (!service) throw new Error('Owner service was revoked')
    return { ...service, cwd: process.cwd() }
  }
  if (own) {
    return {
      key: own,
      cwd: process.cwd(),
      name: liveSessions().get(own)?.session.name,
      pane: process.env.HERDR_PANE_ID,
    }
  }
  if (pane) {
    const p = fromCodex || fromAgy ? reported : await paneOf(pane)
    if (p?.agent) return { key: p.agent_session?.value ?? `pane-${pane}`, cwd: p.cwd ?? '', pane }
  }
  throw new Error('cannot tell which session this is: run it from a Claude session, or pass --session')
}

/** The session running this command, { key, name }, or null outside one. */
function ownSession(): Promise<SessionRef | null> {
  return ownSessionOf({ env: process.env, paneOf, readCard, nameOf: key => liveSessions().get(key)?.session.name })
}

/** The node session (key and lane) for forwarded commands; called only while `node` is configured. */
async function nodeCaller(): Promise<{ key: string; lane: string | null } | null> {
  const s = target ? await resolveSession().catch(() => null) : await ownSession().catch(() => null)
  if (!s) return null
  const card = readCard(s.key)
  const cwd = 'cwd' in s && typeof s.cwd === 'string' && s.cwd ? s.cwd : process.cwd()
  const lane = (typeof card?.category === 'string' && card.category) || categoryFor(cfg, cwd) || null
  return { key: s.key, lane }
}

/** Forward a read command (`cats`, `list`) from a node when the master answers; fall back locally when unreachable. */
async function tryNodeRead(cmd: 'cats' | 'list', fallbackNote: string): Promise<boolean> {
  if (!nodeConfig(cfg.node)) return false
  const caller = await nodeCaller()
  // Outside a session the categories are the owner's, up the relay (#780); the list stays a session's.
  if (!caller?.key && cmd !== 'cats') return false
  const { callBoard, callBoardAsOwner } = await import('./node-call.ts')
  const answer = caller?.key
    ? await callBoard(cfg.port)({ cmd, argv: [], session: caller.key, lane: null, files: [] })
    : await callBoardAsOwner(cfg.port)({ cmd, argv: [] })
  if (answer?.state === 'answered') {
    if (answer.code === UPLINK_REFUSED && answer.err.some(l => /is not taken from a node/i.test(l))) {
      console.error(
        `board ${cmd} is not supported by the board's computer yet: update the master board to a newer version`,
      )
      process.exitCode = 1
      return true
    }
    for (const l of answer.out) console.log(l)
    for (const l of answer.err) console.error(l)
    process.exitCode = answer.code
    return true
  }
  console.error(fallbackNote)
  return false
}

/**
 * The entries the master holds for a session of this node (#806, `board schedule`): its lines, and a
 * note for stderr when it could not say (unreachable, or a master from before it answered this).
 * Asked only while `node` is configured.
 */
async function masterSchedule(key: string): Promise<{ lines: string[]; note: string }> {
  const { callBoard } = await import('./node-call.ts')
  const answer = await callBoard(cfg.port)({ cmd: 'schedule', argv: [], session: key, lane: null, files: [] })
  if (answer?.state === 'answered' && answer.code === 0) return { lines: answer.out, note: '' }
  if (
    answer?.state === 'answered' &&
    answer.code === UPLINK_REFUSED &&
    answer.err.some(l => /is not taken from a node/i.test(l))
  )
    return {
      lines: [],
      note: "note: the board's computer runs an older version and does not list the entries it holds for this session",
    }
  if (answer?.state === 'answered') return { lines: [], note: answer.err.join(' ') }
  return {
    lines: [],
    note: "note: the board's computer is not reachable: the entries it holds for this session are not listed",
  }
}

/** `board unschedule all` on a node (#806): the master's entries for the session go too; its line, or why not. */
async function masterUnscheduleAll(key: string): Promise<void> {
  const { callBoard } = await import('./node-call.ts')
  const answer = await callBoard(cfg.port)({
    id: randomUUID(),
    cmd: 'unschedule',
    argv: ['all'],
    session: key,
    lane: null,
    files: [],
  })
  if (answer?.state === 'answered' && answer.code === 0) for (const l of answer.out) console.log(l)
  else if (answer?.state === 'answered' && answer.code === UPLINK_REFUSED)
    console.error("note: the board's computer runs an older version and kept the entries it holds for this session")
  else if (answer?.state === 'answered') for (const l of answer.err) console.error(l)
  else console.error("note: the board's computer is not reachable: the entries it holds for this session stay there")
}

/**
 * `board doing / done / clear` with decisions on: the card's open decision withdrawn. On a node
 * (#781) its master holds it: it leaves this card, and the master, seeing the card without it,
 * withdraws it there; this computer's database is not opened.
 */
async function withdraw(key: string, now: number): Promise<void> {
  if (!nodeConfig(cfg.node)) return (await import('./decisions-cli.ts')).withdrawDecision(key, now)
  if (readCard(key)?.decision !== undefined) writeCard(key, { decision: '' })
}

/**
 * `board ask` in a session on a node with decisions on (#781). With options its master holds the
 * question (the uplink's `ask`) and this card gets the decision it holds, which the master's board
 * shows and answers; a plain one is this card's ask, as without decisions. A master that is not
 * reachable, or does not take it yet: the question still goes on the card, without options, and
 * the line says so. What goes after the card's line.
 */
async function askOnNode(
  on: NonNullable<ReturnType<typeof decisionsConfig>>,
  s: Session,
  own: boolean,
  now: number,
): Promise<string> {
  const plain = (question: string, note = ''): string => {
    writeCard(s.key, { ask: question, askSince: now, by: 'agent', decision: '' })
    return note
  }
  if (!DECISION_FLAGS.some(f => flagWords.includes(f))) {
    if (!text) throw new Error('usage: board ask <question>')
    return plain(text)
  }
  const after = dashes < 0 ? [] : argv.slice(dashes + 1)
  const { DecisionError, parseAsk } = await import('../core/decisions.ts')
  // Read here first, so a question the master would refuse is refused without a call.
  const spec = parseAsk(flagWords, after, on)
  if (!own)
    throw new DecisionError(
      'other',
      "--option and --default-after are for the session's own question: ask another session's card without them",
    )
  const card = readCard(s.key)
  const lane = (typeof card?.category === 'string' && card.category) || categoryFor(cfg, s.cwd) || null
  const { callBoard } = await import('./node-call.ts')
  const answer = await callBoard(cfg.port)({
    cmd: 'ask',
    argv: [...flagWords, '--', ...after],
    session: s.key,
    lane,
    files: [],
  })
  if (answer?.state === 'answered' && answer.code === 0 && answer.decision) {
    writeCard(s.key, { ask: spec.question, askSince: now, by: 'agent', decision: masterHeld(answer.decision) })
    return answer.out.join(' ')
  }
  if (answer?.state === 'answered' && answer.code !== 0 && answer.code !== UPLINK_REFUSED)
    throw new Error(answer.err.join('\n') || "the board's computer did not take the question")
  const why = answer?.state === 'answered' ? 'does not take questions with options yet' : 'is not reachable'
  return plain(
    spec.question,
    ` · note: the board's computer ${why}, so this asks without options and no default will answer it`,
  )
}

/** Merge master and local node decisions on `board decisions [--done] [--json]` (#698). */
async function decisionsOnNode(args: readonly string[]): Promise<void> {
  const json = args.includes('--json')
  const wantDone = args.includes('--done')
  const unknown = args.filter(w => w !== '--json' && w !== '--done')
  if (unknown.length) throw new Error('usage: board decisions [--done] [--json]')
  const fail = (code: string, message: string, exit = 1): void => {
    if (json) console.log(JSON.stringify({ ok: false, error: code, message }))
    else console.error(message)
    process.exitCode = exit
  }
  const caller = await nodeCaller()
  const argv = [...(wantDone ? ['--done'] : []), '--json']
  const { callBoard, callBoardAsOwner } = await import('./node-call.ts')
  // Outside a session (#780): the owner's, up the relay.
  const answer = caller?.key
    ? await callBoard(cfg.port)({ cmd: 'decisions', argv, session: caller.key, lane: null, files: [] })
    : await callBoardAsOwner(cfg.port)({ cmd: 'decisions', argv })
  const now = Date.now()
  const localOn = decisionsConfig(cfg.decisions) !== null
  const [cliMod, svcMod] = await Promise.all([import('./decisions-cli.ts'), import('../services/decisions.ts')])
  type Row = import('../adapters/decision-store.ts').DecisionRow
  const localOpen: DecisionView[] = svcMod.decisionsFromCards(allCards())
  const localDone: Row[] = svcMod.decisionsDone({ limit: 20 })

  if (answer?.state !== 'answered') {
    if (!localOn && !localOpen.length && !localDone.length)
      return fail(
        answer ? 'unreachable' : 'board',
        answer ? "the board's computer is not reachable" : 'the board does not run on this computer: nothing was sent',
      )
    console.error("note: the board's computer is not reachable; showing this node's decisions only")
    const lines = wantDone
      ? cliMod.formatDecisionsDone(localDone, now, json)
      : cliMod.formatDecisionItems(localOpen, now, json)
    for (const l of lines) console.log(l)
    return
  }
  if (answer.code !== 0) {
    if (answer.code === UPLINK_REFUSED && answer.err.some(l => /is not taken from a node/i.test(l)))
      return fail(
        'master_outdated',
        "board decisions is not supported by the board's computer yet: update the master board to a newer version",
      )
    const parsed = (() => {
      try {
        return JSON.parse(answer.out.join('\n')) as { error?: unknown; message?: unknown }
      } catch {
        return null
      }
    })()
    if (parsed?.error === 'off' && (localOn || localOpen.length || localDone.length)) {
      const lines = wantDone
        ? cliMod.formatDecisionsDone(localDone, now, json)
        : cliMod.formatDecisionItems(localOpen, now, json)
      for (const l of lines) console.log(l)
      return
    }
    if (json && answer.out.length) {
      for (const l of answer.out) console.log(l)
      process.exitCode = answer.code
      return
    }
    if (parsed && typeof parsed.message === 'string')
      return fail(String(parsed.error ?? 'failed'), parsed.message, answer.code)
    for (const l of answer.out) console.log(l)
    for (const l of answer.err) console.error(l)
    process.exitCode = answer.code
    return
  }

  let remote: Record<string, unknown> | null = null
  try {
    remote = JSON.parse(answer.out.join('\n')) as Record<string, unknown>
  } catch {}
  if (wantDone) {
    const byId = new Map<string, Row>()
    const remoteRows = Array.isArray(remote?.done) ? (remote.done as Row[]) : []
    for (const r of remoteRows) byId.set(r.id, r)
    for (const r of localDone) if (!byId.has(r.id)) byId.set(r.id, r)
    const merged = [...byId.values()]
      .sort((a, b) => (b.answeredAt ?? b.askedAt ?? 0) - (a.answeredAt ?? a.askedAt ?? 0))
      .slice(0, 20)
    for (const l of cliMod.formatDecisionsDone(merged, now, json)) console.log(l)
    return
  }
  const byKey = new Map<string, DecisionView>()
  const keyOf = (d: DecisionView): string => (d.id ? `id:${d.id}` : `card:${d.key}\u0000${d.question}`)
  const remoteItems = Array.isArray(remote?.items) ? (remote.items as DecisionView[]) : []
  for (const d of remoteItems) byKey.set(keyOf(d), d)
  for (const d of localOpen) {
    const k = keyOf(d)
    if (!byKey.has(k)) byKey.set(k, d)
  }
  for (const l of cliMod.formatDecisionItems(orderQueue([...byKey.values()]), now, json)) console.log(l)
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

/** One fresh fetch of the web board's payload, else null. */
async function fetchBoard(port: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port) || 12422}/api/board`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json()
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

/** The web board's payload when it answers now (asked once), else null. */
let webBoard: Promise<Record<string, unknown> | null> | undefined
function boardAnswer(): Promise<Record<string, unknown> | null> {
  webBoard ??= fetchBoard(cfg.port)
  return webBoard
}

/** Whether a board that runs the schedule answers now. */
const schedulerRuns = (
  c: typeof cfg = cfg,
  board: () => Promise<Record<string, unknown> | null> = boardAnswer,
): Promise<boolean> => schedulerRunsNow(c.web !== false, board)

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

/** Shared implementation of `board send` (#619) and MCP `SendMessage` (#628). */
async function runSend(
  to: string,
  message: string,
  { fresh = false, config = cfg }: { fresh?: boolean; config?: typeof cfg } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  if (!to.trim() || !message.trim()) return { code: 1, out: [], err: ['usage: board send <name|key> "<text>"'] }
  const s = await resolveSession()
  const { nodeConfig } = await import('../core/nodes.ts')
  if (nodeConfig(config.node)) {
    const { callBoard } = await import('./thread-cli.ts')
    const answer = await callBoard(config.port)({
      cmd: 'send',
      argv: [to, message],
      session: s.key,
      lane: null,
      files: [],
    })
    if (!answer) return { code: 1, out: [], err: ['the board does not run on this computer: nothing was sent'] }
    // Not reachable, or no answer in time: the master may have queued it all the same.
    if (answer.state !== 'answered')
      return {
        code: 1,
        out: [],
        err: ["the board's computer did not answer: it may not have been sent; check before sending it again"],
      }
    return { code: answer.code, out: answer.out, err: answer.err }
  }
  const board = async (): Promise<Record<string, unknown> | null> =>
    config.web === false ? null : fresh ? fetchBoard(config.port) : boardAnswer()
  const body = await board()
  if (!body) return { code: 1, out: [], err: ['the board does not run: nothing was sent (open it first)'] }
  const A = await import('../core/agent-send.ts')
  const own = A.ownDeviceOf(body)
  const targets = A.targetsOf(body.items, own)
  const plan = A.planSend({
    targets,
    to,
    message,
    from: { key: s.key, name: targets.find(t => t.key === s.key)?.name ?? s.name ?? '', device: null },
    own,
    now: Date.now(),
  })
  if ('error' in plan) return { code: 1, out: [], err: [plan.error] }
  addEntry(plan.entry)
  const note = (await schedulerRuns(config, async () => body))
    ? ''
    : ' · note: no board with the scheduler is running now; this goes out once one runs (late, with a note)'
  return { code: 0, out: [`${plan.line}${note}`], err: [] }
}

/**
 * `board send <name|key> "<text>"` (#619, core/agent-send.ts): a message to a session on the board,
 * this computer's or a node's, typed in once it is free and waking it first if it sleeps; the answer
 * comes back the same way. A name two sessions share takes the ref the list shows ("Name [1a2b3c4d]").
 * On a node it goes to the master, which holds the board (services/nodes/uplink.ts), and is not kept
 * when the master is not there.
 */
async function sendCmd(): Promise<void> {
  const [to = '', ...more] = words
  const message = more.join(' ').trim()
  if (!to.trim() || !message) throw new Error('usage: board send <name|key> "<text>"')
  const r = await runSend(to, message)
  for (const l of r.out) console.log(l)
  if (r.code !== 0) {
    // Preserve direct CLI error format (`board: ...`) for local errors, while keeping master lines verbatim.
    const { nodeConfig } = await import('../core/nodes.ts')
    if (!nodeConfig(cfg.node) && r.err.length === 1) throw new Error(r.err[0])
    if (
      r.err.length === 1 &&
      (r.err[0]?.startsWith('the board does not run') || r.err[0]?.startsWith("the board's computer"))
    )
      throw new Error(r.err[0])
    for (const l of r.err) console.error(l)
    process.exitCode = r.code
  }
}

/** Shared implementation of `board agents [--json]` and MCP `ListAgents` (#628). */
async function runAgents({
  json = false,
  fresh = false,
  config = cfg,
}: {
  json?: boolean
  fresh?: boolean
  config?: typeof cfg
} = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  let selfKey = ''
  try {
    const s = target ? await resolveSession() : await ownSession()
    selfKey = s?.key ?? ''
  } catch {}
  const { nodeConfig } = await import('../core/nodes.ts')
  if (nodeConfig(config.node) && selfKey) {
    const { callBoard } = await import('./thread-cli.ts')
    const answer = await callBoard(config.port)({
      cmd: 'agents',
      argv: json ? ['--json'] : [],
      session: selfKey,
      lane: null,
      files: [],
    })
    if (answer?.state === 'answered' && answer.code === 0) return { code: 0, out: answer.out, err: answer.err }
  }
  const body = config.web === false ? null : fresh ? await fetchBoard(config.port) : await boardAnswer()
  const items = body ? body.items : await collect(fresh ? defaultDeps(config) : deps)
  const A = await import('../core/agent-send.ts')
  const own = body ? A.ownDeviceOf(body) : ''
  const targets = A.targetsOf(items, own)
  const offline = body ? A.offlineDevices(body) : new Set<string>()
  if (json) return { code: 0, out: [JSON.stringify(A.agentViewsOf(targets, { selfKey, offline }))], err: [] }
  const lines = A.formatAgentLines(targets, { selfKey, offline, own, now: Date.now() })
  return { code: 0, out: lines.length ? lines : ['no sessions on the board'], err: [] }
}

/** `board agents [--json]` (#628): every reachable session on the board, with its ref and agent kind. */
async function agentsCmd(): Promise<void> {
  const json = flagWords.includes('--json')
  const r = await runAgents({ json })
  for (const l of r.out) console.log(l)
  for (const l of r.err) console.error(l)
  process.exitCode = r.code
}

/** A note for the agent when no board with the scheduler runs to send it. */
async function schedulerNote(): Promise<string> {
  if (await schedulerRuns()) return ''
  return ' · note: no board with the scheduler is running now; this goes out once one runs (late, with a note)'
}

// Times for agents: unambiguous, in local time.
const pad = (n: number): string => String(n).padStart(2, '0')

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

function entryLine(e: ScheduleEntry, now: number, withSession: boolean, parked = false): string {
  const parts =
    e.kind === 'restart' || e.kind === 'sleep'
      ? [e.id, `${e.kind}, asked ${stamp(e.created ?? e.next, zone)}`, restartState(e)]
      : scheduleParts(e, now, zone)
  if (withSession) parts.push(e.name || e.key)
  if (parked) parts.push('parked in the archive')
  if (e.kind !== 'restart' && e.kind !== 'sleep' && waitsPart(e)) parts.push(waitsPart(e, zone))
  if (e.text) parts.push(clip(e.text, 80))
  return parts.join(' · ')
}

/**
 * The lines of entries that wait with archived sessions: due as Return would put them back
 * (services/archive.ts dueAgain), then what else can be done with them.
 */
function parkedLines(held: ScheduleEntry[], now: number, withSession: boolean): string[] {
  if (!held.length) return []
  return [
    ...held.map(e => entryLine({ ...e, next: dueAgain(e, now) ?? e.next }, now, withSession, true)),
    'parked entries come back with their session; board schedule --move <id> moves one to this session (--session <id|name|pane>: to that one), board unschedule <id> removes it',
  ]
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
 * `board todo add [--mine] [--ref <r>] [--why <w>] "<text>" | done <key> [--why <w>] | list` (#202,
 * #319): the agent's side of the tasks, on this session's card, under its lock (adapters/cards.ts
 * changeTodos). A task is named by its key, its number or its id. Done on the user's own task
 * proposes it done for the user to confirm, or closes it where config.json's `autoClose` says so.
 * Refused while tasks are off, or on for the user's pins only.
 */
function todo(key: string): void {
  const usage =
    'usage: board todo add [--mine] [--ref <ticket|file|link>] [--why "<what it waits on>"] "<text>" | board todo done <key> [--why "<what settled it>"] | board todo list'
  const conf = todosConfig(gate.todos)
  if (!conf) throw new Error(t('todo.err.off'))
  if (!conf.agents) throw new Error(t('todo.err.agentsOff'))
  const [sub = 'list', ...args] = rest
  // --ref and --why with their values, --mine; the rest is the text (add) or the task (done), and
  // all of it after a `--`.
  const flags: Record<string, string> = {}
  const words: string[] = []
  let mine = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') {
      words.push(...args.slice(i + 1))
      break
    }
    if ((a === '--ref' || a === '--why') && i + 1 < args.length) flags[a.slice(2)] = args[++i] ?? ''
    else if (a === '--mine') mine = true
    else words.push(a)
  }
  const card = () => readCard(key)
  const listed = (): Todo[] => {
    const c = card()
    return numberTodos(todosOf(c?.todos), Number(c?.todoSeq) || 0).list
  }
  const keyOf = (x: Todo): string => todoKey(card() ?? {}, x)
  if (sub === 'list') {
    const open = sortTodos(listed()).filter(x => !x.done)
    if (!open.length) {
      console.log('no open tasks for this session')
      return
    }
    for (const x of open) {
      const whose = x.owner === 'agent' ? 'yours' : x.proposed ? "the user's, proposed done" : "the user's"
      console.log([keyOf(x), whose, x.text, ...(x.ref ? [`ref ${x.ref}`] : [])].join(' · '))
    }
    return
  }
  if (sub === 'add') {
    const text = words.join(' ').trim()
    if (!text) throw new Error(usage)
    const r = changeTodos(key, {
      op: 'add',
      text,
      owner: mine ? 'agent' : 'user',
      by: 'agent',
      ...(flags.ref !== undefined && { ref: flags.ref }),
      ...(flags.why !== undefined && { why: flags.why }),
    })
    if (!r.ok) throw new Error(t(r.error))
    console.log(`ok · task ${r.todo ? keyOf(r.todo) : ''} · ${mine ? 'yours' : "the user's"}`)
    return
  }
  if (sub === 'done' && words[0]) {
    const found = findTodo(listed(), words[0])
    if (!found) throw new Error(t('todo.err.gone'))
    const r = changeTodos(key, {
      op: 'done',
      id: found.id,
      by: 'agent',
      ...(flags.why !== undefined && { why: flags.why }),
      ...(conf.autoClose && { auto: true }),
    })
    if (!r.ok) throw new Error(t(r.error))
    const x = r.todo ?? found
    console.log(
      x.done ? `ok · task ${keyOf(x)} done` : `ok · task ${keyOf(x)} proposed done: the user confirms it on the board`,
    )
    return
  }
  throw new Error(usage)
}

/**
 * `board presence [here|away|call]` and `board away [on|off]`: the user's presence (#172), read or
 * switched in its file, so with the board closed too; the board shows a switch at its next look.
 * While config.json has no `presence` it is off, and a switch is refused: no file appears.
 */
async function presence(): Promise<void> {
  if (nodeConfig(cfg.node)) {
    const caller = await nodeCaller()
    const { forwardNodeCall } = await import('./node-call.ts')
    process.exitCode = await forwardNodeCall({
      cmd: cmd === 'away' ? 'away' : 'presence',
      argv: [...words],
      session: caller?.key ?? null,
      port: cfg.port,
    })
    return
  }
  const word = (words[0] ?? '').toLowerCase()
  const state: PresenceState | null =
    cmd === 'away'
      ? word === '' || word === 'on'
        ? 'away'
        : word === 'off'
          ? 'here'
          : null
      : word === ''
        ? null
        : isPresenceState(word)
          ? word
          : null
  if (word && !state)
    throw new Error(cmd === 'away' ? 'usage: board away [on|off]' : 'usage: board presence [here|away|call]')
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
  console.log(`ok · ${changed ? '' : 'already '}${p.state}`)
}

const TEAM_USAGE =
  'usage: board team join <invite> --hub <ws://host:7443> --name <name> | board team roster | board team draft <name|peer-id> "<text>" | board team post <name|peer-id|team|@name.agent> [--new "<title>"] [--link <url>] [--file <path>] "<text>" | board team reply <thread> [--to <message>] [--file <path>] "<text>" | board team react <thread> <message> <emoji> [--remove] | board team thread <thread> [--json] [--read] | board team drafts | board team inbox [--unread] [--json] | board team watch [--json] [--every <seconds>] | board team wait [--timeout <seconds>] [--json] | board team assign <thread> <session> | board team release <thread> | board team listen [off] | board team loop <name|peer-id|team> [<1-100>|default] | board team agents [<name|peer-id>] | board team mark-master [off] | board team channel delete <ref> | board team channel leave <ref>'
/** The `board team` ops of agents talking through the hub (#216), in entrypoints/team-agents-cli.ts. */
const TEAM_AGENT_OPS = [
  'post',
  'reply',
  'react',
  'thread',
  'drafts',
  'assign',
  'release',
  'listen',
  'loop',
  'agents',
  'mark-master',
]
/** What came in, read only (#355), in entrypoints/team-inbox-cli.ts. */
const TEAM_INBOX_OPS = ['inbox', 'watch', 'wait']

/**
 * When the board's port answered, but not as this install's board would (#356): the process that
 * holds it, in a line (pid, folder, when it started, what /api/hello says). Null when it is this
 * install's board after all, or the system does not say.
 */
async function strangerOnPort(port: number): Promise<string | null> {
  const { whoHoldsPort } = await import('../adapters/port-owner.ts')
  const { describeOwner } = await import('../core/board-port.ts')
  const { ROOT } = await import('../adapters/paths.ts')
  const { owner, says, why } = await whoHoldsPort(port, ROOT)
  if (!owner || !why) return null
  const who = describeOwner(owner, says, why, Date.now())
  return `port ${port} is held by a process that is not this install's board (${ROOT}): ${who}. Stop it (often an old board server from another checkout) and open the board again`
}

/**
 * `board team join <invite> --hub <url> --name <name>` and `board team roster` (#231). Join makes
 * this board's key (kept only once the hub has said welcome), joins with the invite and writes
 * `team` into config.json; the running board connects within seconds. --name is read off the
 * global parse above (forkName): fork's flag, the same word. Roster asks the running board; with
 * `team` off it says so and touches nothing.
 */
async function team(): Promise<void> {
  if (nodeConfig(cfg.node)) {
    if (rest[0] === 'channel') throw new Error("board team channel is owner-only: run it on the board's computer")
    const forwarded = forkName !== undefined ? [rest[0] ?? '', '--name', forkName, ...rest.slice(1)] : [...rest]
    const op = forwarded[0] ?? ''
    const more = forwarded.slice(1)
    const { teamFileArg } = await import('./team-agents-cli.ts')
    const filePos = teamFileArg(op, more)
    const files = filePos >= 0 ? [resolve(more[filePos] as string)] : []
    const cut = more.indexOf('--')
    const flags = cut < 0 ? more : more.slice(0, cut)
    const kept = isKeptCall('team', forwarded)
    const caller = await nodeCaller()
    const { forwardNodeCall } = await import('./node-call.ts')
    process.exitCode = await forwardNodeCall({
      cmd: 'team',
      argv: forwarded,
      session: caller?.key ?? null,
      lane: caller?.lane ?? null,
      files,
      ...(kept && { id: randomUUID() }),
      ...(target && { claimed: true }),
      port: cfg.port,
      json: flags.includes('--json'),
    })
    return
  }
  const [op, ...more] = rest
  // Loaded here: no other command of the board command pays for the peer network.
  const T = await import('../core/team.ts')
  const store = await import('../adapters/team-store.ts')
  if (op === 'join') {
    // --hub is read before a lone -- only; a word after it is a plain word (#476).
    const { flags, after } = (await import('./team-agents-cli.ts')).cutAtDashes(more)
    const hi = flags.indexOf('--hub')
    const given = hi >= 0 ? flags[hi + 1] : undefined
    const words = [...flags.filter((_, i) => hi < 0 || (i !== hi && i !== hi + 1)), ...after]
    const invite = words[0]
    const have = isRecord(cfg.team) ? cfg.team : {}
    const hub = T.normalizeHub(given ?? have.hub) ?? ''
    const name = forkName ?? (typeof have.name === 'string' ? have.name : '')
    if (!invite || words.length !== 1 || !hub || !T.validName(name)) throw new Error(TEAM_USAGE)
    const saved = store.readKey()
    const key = saved ?? (await T.generateKey())
    const { joinHub, TRIES, TRY_MS } = await import('../services/team-join.ts')
    const { probeHub } = await import('../adapters/hub-reach.ts')
    const { pause } = await import('../adapters/pacing.ts')
    // From the moment a join goes out the hub may take the invite for this key, so a new key is
    // saved first: an interrupt between tries, or no answer at all, must not lose it. It is taken
    // back once the hub has settled that the join did not land.
    let wrote = false
    const r = await joinHub(
      { hub, invite, name, key, keyWasSaved: saved !== null },
      {
        tryMs: Number(process.env.BOARD_TEAM_JOIN_MS) || TRY_MS,
        tries: TRIES,
        probe: probeHub,
        say: line => console.error(`board: ${line}`),
        pause,
        beforeJoin: async () => {
          if (saved || wrote) return
          await store.keepJoinedKey(key)
          wrote = true
        },
      },
    )
    if (!r.ok) {
      if (!r.unanswered) {
        if (wrote) store.forgetKey(key.pub)
        throw new Error(r.error)
      }
      throw new Error(
        `${r.error}. The join went out and may have reached the hub: this board keeps its key, so the same command again finds out`,
      )
    }
    await store.keepJoinedKey(key)
    const w = (await import('../adapters/config-file.ts')).joinTeam({ hub, name })
    if (!w.ok) throw new Error(w.error)
    const late = r.via === 'auth' ? ' (the hub knew this key already)' : ''
    return console.log(
      `ok · joined ${hub} as ${name}${late} · your key ${T.fingerprint(key.pub)} · the running board connects in a few seconds`,
    )
  }
  const agentOp = TEAM_AGENT_OPS.includes(op ?? '')
  const inboxOp = TEAM_INBOX_OPS.includes(op ?? '')
  if (op === 'draft' || op === 'channel' ? more.length !== 2 : !agentOp && !inboxOp && (op !== 'roster' || more.length))
    throw new Error(TEAM_USAGE)
  if (op === 'channel' && target) throw new Error('board team channel is owner-only and does not take --session')
  if (!T.teamConfig(cfg.team)) {
    return console.log(
      'team is off (no "team" in config.json; `board team join <invite> --hub <url> --name <name>` turns it on)',
    )
  }
  const webPort = Number(cfg.port) || 12422
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/team`, { signal: AbortSignal.timeout(3000) })
  } catch {
    throw new Error('the board does not run: open it first (herdr plugin action invoke agent-board.open)')
  }
  const view: unknown = await res.json().catch(() => undefined)
  if (!isRecord(view) || !Array.isArray(view.roster))
    throw new Error(
      (await strangerOnPort(webPort)) ??
        (view === undefined
          ? 'the board does not run: open it first (herdr plugin action invoke agent-board.open)'
          : 'the board does not run the team: restart it'),
    )
  const serviceKey = process.env.CLAUDE_CODE_SESSION_ID
  const serviceReads = isOwnerServiceKey(serviceKey)
    ? await (async () => {
        const [{ sharesAnyLane }, { switchesKey }] = await Promise.all([
          import('../core/team-agents.ts'),
          import('../services/team-router.ts'),
        ])
        return (scope: string, thread: string | null = null) => {
          if (!ownerServices().some(service => service.key === serviceKey)) return false
          const switches = store.readAgents()
          const peer = switches.peers[switchesKey(scope, thread)]
          return (
            !switches.off &&
            (!isRecord(cfg.team) || cfg.team.agents !== false) &&
            peer?.on === true &&
            sharesAnyLane(peer, cfg.categories)
          )
        }
      })()
    : undefined
  if (inboxOp) {
    const I = await import('./team-inbox-cli.ts')
    const ctx = { webPort, roster: view.roster, ...(serviceReads && { canRead: serviceReads }) }
    if (op === 'inbox') return console.log(await I.teamInbox(more, ctx))
    if (op === 'wait') {
      // A session with no pane to type a notice into (#819): it asks for its threads instead.
      const w = I.waitFlags(more)
      if (!w) throw new Error(TEAM_USAGE)
      return console.log(await I.teamWait(ctx, { ...w, self: async () => ({ key: (await resolveSession()).key }) }))
    }
    const flags = I.watchFlags(more)
    if (!flags) throw new Error(TEAM_USAGE)
    return await I.teamWatch(ctx, { ...flags, out: l => console.log(l) })
  }
  if (agentOp) {
    const A = await import('./team-agents-cli.ts')
    const line = await A.teamAgents(op ?? '', more, {
      webPort,
      roster: view.roster,
      ...(serviceReads && { canRead: serviceReads, hideFilePaths: true }),
      self: async () => {
        const s = await resolveSession()
        return { key: s.key, ...(s.name && { name: s.name }), ...(target && { claimed: true }) }
      },
      find: async word => {
        if (UUID.test(word)) return { key: word }
        const t = word.toLowerCase()
        const item = (await collect(deps)).find(i =>
          [i.name, i.autoName, i.pane, i.session, i.key].some(v => v && v.toLowerCase() === t),
        )
        if (!item) throw new Error(`no session "${T.printable(word)}" on the board`)
        return { key: item.key, ...(item.name && { name: item.name }) }
      },
    })
    return console.log(line)
  }
  if (op === 'draft') {
    const A = await import('./team-agents-cli.ts')
    console.log(A.teamHeaderLine(view))
    return console.log(await A.teamDraftTo(webPort, view.roster, more[0] ?? '', more[1] ?? ''))
  }
  if (op === 'channel') {
    const A = await import('./team-agents-cli.ts')
    return console.log(await A.teamChannel(more, { webPort, roster: view.roster }))
  }
  const A = await import('./team-agents-cli.ts')
  const visible = serviceReads
    ? { ...view, roster: view.roster.filter(p => isRecord(p) && serviceReads(String(p.peer))) }
    : view
  for (const l of A.teamRosterLines(visible)) console.log(l)
}

async function main(): Promise<void> {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(usageText())
  // A command's help, and nothing else: before any session is looked for (#305). thread, time and
  // cal print their own, fuller one.
  if (helpAsked && !OWN_HELP.has(cmd)) {
    // team and workdesk keep the fuller usage they print for a wrong word.
    if (cmd === 'team') return console.log(TEAM_USAGE)
    if (cmd === 'workdesk')
      return console.log(`usage: ${(await import('../services/workdesk-workers.ts')).WORKERS_USAGE}`)
    return console.log(usageOf(cmd))
  }

  if (cmd === 'cats') {
    if (await tryNodeRead('cats', "note: the board's computer is not reachable; showing this node's categories only"))
      return
    const known = cfg.categories.map(c => `${c.id} (${categoryInfo(cfg, c.id).title})`).join(', ')
    return console.log(`${known}. A new id makes a new lane. Config: ${configFile()}`)
  }

  if (cmd === 'list') {
    if (await tryNodeRead('list', "note: the board's computer is not reachable; showing this node's sessions only"))
      return
    const items = await collect(deps)
    const soonest = new Map<string, number>()
    for (const e of listEntries()) if (!soonest.has(e.key)) soonest.set(e.key, e.next)
    for (const l of formatListLines(items, cfg, { soonest, now: Date.now(), includeNote: true })) console.log(l)
    return
  }

  if (cmd === 'update') return isNodeOnly(cfg) ? updateFromMaster() : selfUpdateNow()

  if (cmd === 'housekeeping') {
    const usageErr = 'usage: board housekeeping --dry-run [--json] | board housekeeping status [--json]'
    const allowed = new Set(['--dry-run', 'dry-run', 'status', '--json'])
    if (rest.some(a => !allowed.has(a))) throw new Error(usageErr)
    const asJson = rest.includes('--json')
    const wantStatus = rest.includes('status')
    const wantDryRun = rest.includes('--dry-run') || rest.includes('dry-run')
    if (wantStatus && wantDryRun) throw new Error(usageErr)
    const { formatDryRun, formatMb } = await import('../core/housekeeping.ts')
    const port = Number(cfg.port) || 12422
    const url = `http://127.0.0.1:${port}/api/housekeeping`
    if (wantStatus) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (!res?.ok) throw new Error('the board is not running on this computer')
      const view = (await res.json()) as import('../services/housekeeping.ts').HousekeepingView
      if (asJson) {
        console.log(JSON.stringify(view, null, 2))
      } else {
        const mem = view.config.memory
        const tabs = view.config.tabs
        const avail = view.lastMemAvailableMb !== null ? formatMb(view.lastMemAvailableMb) : 'unknown'
        console.log(
          `memory guard: ${mem.on ? 'on' : 'off'} (warn: ${mem.warnMb ? formatMb(mem.warnMb) : 'auto'}, action: ${mem.actionMb ? formatMb(mem.actionMb) : 'auto'}, last available: ${avail})`,
        )
        console.log(
          `browser tabs: ${tabs.on ? 'on' : 'off'} (idle >= ${tabs.idleMinutes} min, every ${tabs.intervalMin} min)`,
        )
        if (view.log.length) {
          console.log('recent:')
          for (const entry of view.log.slice(0, 5)) {
            console.log(`  ${new Date(entry.at).toISOString()} · ${entry.text}`)
          }
        }
      }
      return
    }
    // Try live board first, fall back to a read-only local dry run (with timers disabled) if offline.
    const live = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'dry-run' }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    let report: import('../core/housekeeping.ts').HousekeepingDryRun
    if (live?.ok) {
      const body = (await live.json()) as { report: import('../core/housekeeping.ts').HousekeepingDryRun }
      report = body.report
    } else {
      const { createHousekeeping } = await import('../services/housekeeping.ts')
      const items = await collect(deps).catch(() => [])
      const hk = createHousekeeping({ deps, items: () => items, log: () => {}, timers: false })
      try {
        report = await hk.dryRun()
      } finally {
        hk.close()
      }
    }
    if (asJson) console.log(JSON.stringify(report, null, 2))
    else for (const line of formatDryRun(report)) console.log(line)
    return
  }

  if (cmd === 'doctor') {
    const { gatherFacts } = await import('../adapters/setup-facts.ts')
    const { checkSetup, report } = await import('../core/setup.ts')
    const facts = await gatherFacts(cfg)
    const checks = checkSetup(facts, t)
    // What herdr's panes hold (#243): asked here only, not in the web board's setup note.
    const { paneFacts } = await import('../adapters/pane-facts.ts')
    const { paneChecks, wakeKeepsSleepers } = await import('../core/pane-report.ts')
    const panes = await paneFacts(wakeKeepsSleepers(facts.wakeNew?.state))
    if (panes) checks.push(...paneChecks(panes, t))
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
    // The board's database and its backup (#233), once there is either: else nothing is asked.
    const { backupChecks } = await import('../services/backup.ts')
    checks.push(...backupChecks(cfg, t))
    // Time tracking's config (#233), while time is on.
    const { timeChecks } = await import('../services/time.ts')
    checks.push(...timeChecks(cfg, t))
    // The secret sinks' config (#273), once config.json has `secrets`.
    const { secretsChecks } = await import('../services/secrets.ts')
    checks.push(...secretsChecks(cfg, t))
    // The update of itself from git (#617): its state file, once it is on or did something.
    const { selfUpdateCheck } = await import('../core/self-update.ts')
    const { readSelfUpdate } = await import('../adapters/self-update.ts')
    const updates = selfUpdateCheck(cfg.autoUpdate, readSelfUpdate(), Date.now(), t)
    if (updates) checks.push(updates)
    // Who holds the board's port (#356): the system is asked only when something listens there.
    const port = await import('../adapters/port-owner.ts')
    if (await port.listening(webPort)) {
      const { portCheck } = await import('../core/board-port.ts')
      const { ROOT } = await import('../adapters/paths.ts')
      const { owner, says, why } = await port.whoHoldsPort(webPort, ROOT)
      const c = portCheck(webPort, owner, says, why, ROOT, Date.now(), t)
      if (c) checks.push(c)
    }
    return console.log(report(checks, t))
  }

  // Neither needs to know which session asks.
  if (cmd === 'schedule' && flagWords.includes('--all')) {
    const list = listEntries()
    const parked = listArchive().flatMap(r => r.held)
    const watches = listWatches()
    if (!list.length && !parked.length && !watches.length) return console.log('nothing scheduled')
    for (const e of list) console.log(entryLine(e, Date.now(), true))
    for (const l of await watchLines(watches, true)) console.log(l)
    for (const l of parkedLines(parked, Date.now(), true)) console.log(l)
    return
  }
  if (cmd === 'unschedule' && words[0] && words[0].toLowerCase() !== 'all') {
    const id = words[0].toLowerCase()
    // Not in the schedule: one parked with an archived session goes from its record.
    const removed = removeEntry(id)
    const held = removed ? null : heldEntry(id)
    const e = removed ?? (held && dropHeld(held.record.key, id)[0])
    // A watch (#486), whether watches are on or not: removing one runs nothing.
    const watch = e ? null : removeWatch(id)
    if (watch)
      return console.log(
        `ok · removed watch ${watch.id}${watch.name ? ` (${watch.name})` : ''}: ${clip(watch.probe.cmd)}`,
      )
    if (!e && nodeConfig(cfg.node)) {
      const caller = await nodeCaller()
      const { forwardNodeCall } = await import('./node-call.ts')
      process.exitCode = await forwardNodeCall({
        cmd: 'unschedule',
        argv: [words[0]],
        session: caller?.key ?? null,
        port: cfg.port,
      })
      return
    }
    if (!e) throw new Error(`no entry "${words[0]}"; see board schedule`)
    return console.log(
      `ok · removed ${e.id} (${e.cron ? `every "${e.cron}"` : stamp(e.next)}${e.name ? `, ${e.name}` : ''}${held ? ', parked in the archive' : ''}): ${clip(e.text)}`,
    )
  }
  if (cmd === 'call-report') return callReport()
  if (cmd === 'remote') return remote()
  if (cmd === 'tunnel') return tunnel()
  if (cmd === 'node') return nodeCmd()
  if (cmd === 'nodes') return nodesCmd()
  if (cmd === 'master') return masterCmd()
  if (cmd === 'backup') return backupCmd()
  if (cmd === 'time') return timeCommand()
  if (cmd === 'spend') return spendCommand()
  if (cmd === 'cal') return calCommand()
  if (cmd === 'thread') return threadCommand()
  if (cmd === 'send') return sendCmd()
  if (cmd === 'agents') return agentsCmd()
  if (cmd === 'workdesk') {
    if (target !== undefined) throw new Error('Workdesk workers uses the calling master session')
    const { workdeskWorkerCommand } = await import('../services/workdesk-workers.ts')
    return workdeskWorkerCommand(words, cfg.workdesk)
  }
  if (cmd === 'mcp') return mcpCommand()
  if (cmd === 'secret') return secretCommand()
  if (cmd === 'db') return dbCmd()
  if (cmd === 'archive') return archive()
  if (cmd === 'sleep') return sleep()
  if (cmd === 'move') return move()
  if (cmd === 'fork') return fork()
  if (cmd === 'resume')
    return flagWords.includes('--pi')
      ? resumePi()
      : flagWords.includes('--agy')
        ? resumeAgy()
        : flagWords.includes('--codex')
          ? resumeCodex()
          : resume()
  if (cmd === 'tg-key') return tgKey()
  if (cmd === 'presence' || cmd === 'away') return presence()
  if (cmd === 'journal') return journalCommand()
  if (cmd === 'ns-sessions') {
    process.exitCode = await (await import('./ns-sessions-cli.ts')).nsSessionsCommand(words, cfg.port)
    return
  }
  if (cmd === 'team') return team()
  if (cmd === 'decisions') {
    if (nodeConfig(cfg.node)) return decisionsOnNode(words)
    if (!decisionsConfig(cfg.decisions)) throw new Error('decisions are off on this board (config.json "decisions")')
    return (await import('./decisions-cli.ts')).decisionsCommand(words, Date.now())
  }

  // On a node, `remind`/`every` aimed at a non-local session goes to the master over the uplink;
  // reminders for this session or another session on the same node stay local.
  if ((cmd === 'remind' || cmd === 'every') && target !== undefined && nodeConfig(cfg.node)) {
    const own = await ownSession()
    const tl = target.toLowerCase()
    const localItems = await collect(deps).catch((): Item[] => [])
    const hit = localItems.find(i =>
      [i.name, i.autoName, i.pane, i.session, i.key].some(v => v && v.toLowerCase() === tl),
    )
    const ownPane = process.env.HERDR_PANE_ID
    const isLocal =
      Boolean(hit) || (own ? tl === own.key.toLowerCase() || (ownPane ? tl === ownPane.toLowerCase() : false) : false)
    if (!isLocal) {
      const argvOut = [
        '--session',
        target,
        ...(idle ? ['--idle'] : []),
        ...flagWords,
        ...(dashes < 0 ? [] : argv.slice(dashes)),
      ]
      const { forwardNodeCall } = await import('./node-call.ts')
      process.exitCode = await forwardNodeCall({
        cmd,
        argv: argvOut,
        session: own?.key ?? null,
        port: cfg.port,
      })
      return
    }
  }

  // schedule --move <id>: a parked entry to this session (or --session's, which must be on the board).
  const mv = cmd === 'schedule' ? flagWords.indexOf('--move') : -1
  const moving = mv >= 0 ? (flagWords[mv + 1] ?? '') : null
  // Listing and removing reach an archived session's parked entries; nothing else is for one.
  const s = await resolveSession({ archived: (cmd === 'schedule' && moving === null) || cmd === 'unschedule' })
  const now = Date.now()
  // A watch that doing, done, clear or a new wait ended (#486), for the line.
  let ended = ''
  // Case files (#488): a session that holds a case whose state is behind its work hears so; read before done clears doingAt.
  const nudge = (cmd === 'wait' || cmd === 'done') && !target ? await caseNudge(s.key) : ''
  // Decisions (#487): only while config.json turns them on; `tail` is what `board ask` adds to the card's line.
  const decisionsOn = decisionsConfig(gate.decisions)
  let tail = ''
  switch (cmd) {
    case 'show':
      break
    case 'cat': {
      const id = (words[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (!id) throw new Error(`usage: board cat <id> ["<Title>"]; known: ${cfg.categories.map(c => c.id).join(', ')}`)
      // A new id with a title becomes a real category (config.json), not just a lane named by its id.
      const title = words.slice(1).join(' ').trim()
      const known = cfg.categories.some(c => c.id === id)
      if (isOwnerServiceKey(s.key) && !known && id !== 'other')
        throw new Error('Owner services can select an existing lane only')
      if (title && !known) {
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
      if (decisionsOn) await withdraw(s.key, now)
      // Back at work: whatever it waited for has arrived, whatever it asked is settled.
      writeCard(s.key, { doing: text, wait: '', waitSince: '', ask: '', askSince: '', result: '', by: 'agent' })
      ended = await endWatch(s)
      break
    case 'wait': {
      // With watches on (#486), --probe before a `--` makes a watch (entrypoints/watch-cli.ts).
      if (watchesConfig(gate.watches) && flagWords.includes('--probe')) {
        // Only for the caller's own wait: a command one session sets would otherwise run unattended
        // in another session's folder.
        if (target && (await ownSession())?.key !== s.key)
          throw new Error(
            "--probe sets a watch for this session's own wait only: drop --session, or let that session run board wait --probe itself",
          )
        const { waitProbe } = await import('./watch-cli.ts')
        return console.log(
          await waitProbe({
            entry: await entryFor(s),
            flagWords,
            after: dashes < 0 ? [] : argv.slice(dashes + 1),
            now,
            setWait: wait => writeCard(s.key, { wait, waitSince: now, by: 'agent' }),
            note: schedulerNote,
            alsoEnd: await takenOver(s),
          }),
        )
      }
      if (!text) throw new Error('usage: board wait <text>')
      writeCard(s.key, { wait: text, waitSince: now, by: 'agent' })
      ended = await endWatch(s)
      // Watches off (#486): --probe is words of the text, as before; said only where it was given.
      if (!watchesConfig(gate.watches) && flagWords.includes('--probe'))
        ended = ' · note: watches are off in config.json, so --probe is part of the wait text and nothing will check it'
      break
    }
    case 'ask':
      // Decisions (#487): options, a recommendation and a default, only while config.json turns them on.
      // On a node (#781) a question with options is its master's: up the uplink, and on this card with
      // the decision the master holds; a plain one stays this card's ask, as without decisions.
      if (decisionsOn && nodeConfig(cfg.node)) {
        tail = await askOnNode(decisionsOn, s, target ? (await ownSession())?.key === s.key : true, now)
        break
      }
      if (decisionsOn) {
        const { askCommand } = await import('./decisions-cli.ts')
        const card = readCard(s.key)
        const lane = (typeof card?.category === 'string' && card.category) || categoryFor(cfg, s.cwd) || null
        // Options and a default only on a session's own question: the board types the default in as if
        // the session had asked, so --session for another one takes a plain ask.
        const own = !target || (await ownSession())?.key === s.key
        tail = askCommand(decisionsOn, { ...s, lane, own }, flagWords, dashes < 0 ? [] : argv.slice(dashes + 1), now)
        break
      }
      // Needs the user: the card goes to "Needs me" until the user's next prompt (entrypoints/hook.ts clears it).
      if (!text) throw new Error('usage: board ask <question>')
      // `decision: ''` takes off one left from when decisions were on (#487); on any other card it writes nothing.
      writeCard(s.key, { ask: text, askSince: now, by: 'agent', decision: '' })
      // Decisions off (#596): the options' flags are words of the question, as before; said only where given.
      {
        const given = DECISION_FLAGS.filter(f => flagWords.includes(f))
        if (given.length)
          tail = ` · note: decisions are off in config.json, so ${given.join(', ')} ${given.length > 1 ? 'are' : 'is'} part of the question and no default will answer it`
      }
      break
    case 'done':
      if (decisionsOn) await withdraw(s.key, now)
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: text, by: 'agent' })
      ended = await endWatch(s)
      break
    case 'clear':
      if (decisionsOn) await withdraw(s.key, now)
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '' })
      ended = await endWatch(s)
      break
    case 'favorite': {
      const off = words[0]?.toLowerCase()
      if (off !== undefined && off !== 'off') throw new Error('usage: board favorite [off]')
      writeCard(s.key, { favorite: off ? '' : true })
      break
    }
    case 'remind': {
      const { at, text: msg } = parseRemindRest(rest, now, { idle, zone })
      const e = addEntry({ ...(await entryFor(s)), ...mode(), text: msg, at, next: at, by: 'agent' })
      return console.log(formatRemindOk(e.id, at, now, idle, msg, await schedulerNote(), zone))
    }
    case 'every': {
      const { cron, next, text: msg } = parseEveryRest(rest, now, { idle, zone })
      const e = addEntry({ ...(await entryFor(s)), ...mode(), text: msg, cron: cron.expr, next, by: 'agent' })
      return console.log(formatEveryOk(e.id, cron.expr, next, now, idle, msg, await schedulerNote(), zone))
    }
    case 'restart':
      return restart(s)
    case 'schedule': {
      if (moving !== null) return moveParked(moving, s, now)
      const list = listEntries().filter(e => e.key === s.key)
      const parked = getArchived(s.key)?.held ?? []
      const watches = listWatches().filter(w => w.key === s.key)
      // On a node (#806): what the master holds for this session too (a handover brought it there).
      const held = nodeConfig(cfg.node) ? await masterSchedule(s.key) : null
      if (!list.length && !parked.length && !watches.length && !held?.lines.length) {
        if (held?.note) console.error(held.note)
        return console.log('nothing scheduled for this session')
      }
      for (const e of list) console.log(entryLine(e, now, false))
      for (const l of held?.lines ?? []) console.log(l)
      for (const l of await watchLines(watches, false)) console.log(l)
      for (const l of parkedLines(parked, now, false)) console.log(l)
      if (held?.note) console.error(held.note)
      return
    }
    case 'todo':
      return todo(s.key)
    case 'compact':
      return console.log(compactCli(s.key, rest, cfg))
    case 'unschedule': {
      // An id is removed above, whoever set it; here only "all" of this session's, parked ones too.
      if (words[0]?.toLowerCase() !== 'all') throw new Error('usage: board unschedule <id|all>')
      const mine = listEntries().filter(e => e.key === s.key)
      for (const e of mine) removeEntry(e.id)
      const n = mine.length + dropHeld(s.key).length + endWatches(s.key, await takenOver(s)).length
      console.log(`ok · removed ${n} ${n === 1 ? 'entry' : 'entries'}`)
      // On a node (#806): the master's for this session too.
      if (nodeConfig(cfg.node)) await masterUnscheduleAll(s.key)
      return
    }
    default:
      throw new Error(`unknown command "${cmd}". ${usageText()}`)
  }
  const cat = readCard(s.key)?.category
  const extra = cat && !cfg.categories.some(c => c.id === cat) ? ` (new lane "${categoryInfo(cfg, cat).title}")` : ''
  // The watch's words first, then the case files' nudge (#488).
  console.log(`ok · ${line(s.key, s.cwd)}${extra}${ended}${nudge}${tail}`)
}

/**
 * Watches the session before a /clear left in this session's pane, which the scheduler would follow
 * into this one (#486, services/watches.ts takenOver). herdr is asked only when a watch of another
 * key names this pane; not known, none.
 */
async function takenOver(s: Session): Promise<string[]> {
  if (!watchesConfig(gate.watches) || !s.pane) return []
  const there = listWatches().filter(w => w.key !== s.key && w.pane === s.pane)
  if (!there.length) return []
  try {
    const watches = await import('../services/watches.ts')
    return watches.takenOver(s, there, await collect(deps), deps)
  } catch {
    return []
  }
}

/** Ends the session's watch while watches are on (#486); the words its line gets for that. */
async function endWatch(s: Session): Promise<string> {
  if (!watchesConfig(gate.watches)) return ''
  const gone = endWatches(s.key, await takenOver(s))
  return gone.length ? ` · watch ${gone.map(w => w.id).join(', ')} ended` : ''
}

/** The lines of watches in `board schedule` (entrypoints/watch-cli.ts). */
async function watchLines(list: WatchEntry[], withSession: boolean): Promise<string[]> {
  const { watchLine } = await import('./watch-cli.ts')
  const on = !!watchesConfig(gate.watches)
  return list.map(w => watchLine(w, Date.now(), withSession, on))
}

/** Whether config.json turned case files on (#488), read without loading threads: off, nothing more is done. */
const casesOn = (): boolean =>
  typeof cfg.threads === 'object' &&
  cfg.threads !== null &&
  !Array.isArray(cfg.threads) &&
  !switchedOff(cfg.threads) &&
  (cfg.threads as { cases?: unknown }).cases === true

/**
 * The tail `board wait`, `board done` and `board sleep --self` add for the open cases the session
 * holds whose state is behind its work (#488, services/work-cases.ts); '' with cases off, before
 * anything is read. Never fails the command.
 */
async function caseNudge(key: string): Promise<string> {
  if (!casesOn()) return ''
  try {
    const { nudgesFor } = await import('../services/work-cases.ts')
    const { nudgeTail } = await import('../core/work-cases.ts')
    const doingAt = readCard(key)?.doingAt
    return nudgeTail(nudgesFor(cfg, key, typeof doingAt === 'number' ? doingAt : undefined))
  } catch {
    return ''
  }
}

/**
 * `board schedule --move <id>`: an entry parked with an archived session moves to this session (or
 * --session's), with its pane and folder, into the schedule as Return would put it back
 * (services/archive.ts moveHeld). Only to a session that is not in the archive itself; an entry
 * in the schedule already is not moved.
 */
async function moveParked(id: string, s: Session, now: number): Promise<void> {
  if (!id) throw new Error('usage: board schedule --move <id> [--session <id|name|pane>]')
  if (getArchived(s.key))
    throw new Error(`${s.name || s.key} is in the archive too; move the entry to a session on the board`)
  const { from, ...to } = await entryFor(s)
  const e = moveHeld(id.toLowerCase(), to)
  if (!e) throw new Error(`no entry "${id}" is parked in the archive; see board schedule --all`)
  const when = e.cron ? `every "${e.cron}", next ${stamp(e.next)}` : stamp(e.next)
  console.log(
    `ok · moved ${e.id} to ${to.name || to.key.slice(0, 8)}: ${when} (${fromNow(e.next, now)}): ${clip(e.text)} · cancel: board unschedule ${e.id}${await schedulerNote()}`,
  )
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
  // Keep find(s.key) after wakeAnswers for plain Claude sessions so a refused restart does no
  // extra herdr snapshot / collect work (#638 review).
  const agyHint = known
    ? isAgyItem(known.find(i => i.key === s.key || i.session === s.key) ?? {})
    : !target && agyCaller()
  const codexHint = known
    ? isCodexItem(known.find(i => i.key === s.key || i.session === s.key) ?? {})
    : !target && codexCaller()
  const up = await wakeAnswers(deps)
  if (!up.ok)
    throw new Error(
      `a restart needs ${wakeMissing(up)}; nothing was scheduled. Ask the user to restart this session by hand: /exit in it, then ${codexHint ? `codex resume ${s.key}` : agyHint ? `agy --conversation ${s.key}` : `claude --resume ${s.key}`} in the same pane`,
    )
  // The restart ends in a wake: one the board would refuse (another profile than herdr-wake would
  // resume it in, or one not known) is refused now, before anything is scheduled. The session as
  // the board shows it, else as its card says.
  const set = await boardProfiles()
  const shown = await find(s.key)
  const isAgy = shown ? isAgyItem(shown) : !target && agyCaller()
  const isCodex = shown ? isCodexItem(shown) : codexHint
  if (isCodex && !wakeSleepsAgy(deps)) throw new Error('a restart of a Codex session needs the board’s own wake')
  if (isAgy && !wakeSleepsAgy(deps))
    throw new Error(
      `a restart of an Antigravity session needs the board’s own wake (Settings → Sleep and wake…); nothing was scheduled. Ask the user to restart this session by hand: /exit in it, then agy --conversation ${s.key} in the same pane`,
    )
  const guard = await checkWake(
    deps,
    shown ?? {
      name: s.name || s.key.slice(0, 8),
      pane: s.pane,
      session: s.key,
      cwd: s.cwd,
      ...(isAgy && { agent: AGY_AGENT }),
      ...(isCodex && { agent: CODEX_AGENT }),
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
    ? isCodex
      ? ' · end your turn now'
      : isAgy
        ? ' · end your turn now. It waits for running subagents to end (10 min at most, then tells you it did not happen)'
        : ' · end your turn now. It waits for background commands and Monitor to end (10 min at most, then tells you it did not happen); CronCreate and ScheduleWakeup jobs die with it'
    : ''
  const resumeLine = isCodex
    ? 'Codex exits and resumes the same conversation'
    : isAgy
      ? 'Antigravity exits and resumes in the same pane (MCP servers, settings, hooks and skills load anew, the conversation stays)'
      : 'Claude exits and resumes in the same pane (MCP servers, settings, hooks, skills and CLAUDE.md load anew, the conversation stays)'
  console.log(
    `${head}: ${turn}, ${resumeLine}, then gets "${prompt}"${stops} · cancel: board unschedule ${entry.id}${await schedulerNote()}`,
  )
}

/**
 * `board fork [--name <Name>] [note]`: a fork of this session (or --session's), started by the web
 * board as its Fork button does (services/launch/fork.ts): a new tab with a copy of the
 * conversation, the session's folder, lane, workspace and profile; the session itself goes on as
 * it is. Without a web board answering there is no fork: it is the board that starts it.
 */
async function fork(): Promise<void> {
  // On a node (#786), another machine's session by its key: its board forks it, through the master.
  const node = nodeConfig(cfg.node)
  const { foreignTargets } = await import('./node-remote-cli.ts')
  // Its bare id or name (#798): another machine's when none of this computer's answers to it.
  const up =
    node && target && !foreignTargets([target], node.id) ? (await foreignTargetsUp([target], node.id))[0] : target
  const key = node && up && foreignTargets([up], node.id) ? up : undefined
  const s = key ? { key, name: target || key } : await resolveSession()
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
  const input = {
    ...o,
    card: readCard(o.session),
    // The list the wake process reads too (services/deps.ts profiles): the listed and found
    // folders, and the one this env points to.
    profiles: deps.profiles().list,
    launch: cfg.launch,
    env: process.env,
    home: homedir(),
  }
  const plan = resumePlan(input)
  const [file = 'claude', ...argv] = plan.argv
  const dir = plan.dir ?? resolveProfileDir(process.env.CLAUDE_CONFIG_DIR, homedir())
  let env = plan.env
  // The profile's env file (#507), on a node or the master alike (#824); no file, env as it was.
  const { readNodeEnv } = await import('../adapters/node-env.ts')
  env = withNodeEnv(
    env,
    readNodeEnv(resumeProfileId(input), msg => console.error(`board resume: ${msg}`)),
  )
  const ran = await runHere(file, argv, env, (await resumeFolder(o.session, dir)) ?? undefined)
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
 * `board resume --agy <id>`: an Antigravity (`agy`) session wake put to sleep resumed in this
 * terminal (#631), using the command line wake kept (falling back to `launch.agy`, default `agy`),
 * with `--conversation <id>` in the session's folder. Asks herdr nothing; exits with `agy`'s code.
 */
async function resumeAgy(): Promise<void> {
  const id = parseAgyResume(rest)
  const lower = id.toLowerCase()
  const sleeper = Object.values(peekAgySleepers()).find(s => s.session.toLowerCase() === lower)
  const session = sleeper?.session ?? id
  if (!deps.agy.hasConversation(session))
    throw new Error(`no Antigravity conversation ${id}: not found under ${deps.agy.root}`)
  let fallback: string[] = [AGY_AGENT]
  try {
    fallback = agyCommand(cfg.launch?.agy)
  } catch {}
  const plan = agyResumeArgv(sleeper?.argv ?? [], session, fallback)
  if ('error' in plan) console.error(`board resume --agy: ${plan.error}; agy starts with --conversation only`)
  const [program = AGY_AGENT, ...argv] = 'argv' in plan ? plan.argv : [...fallback, '--conversation', session]
  const rawCwd = sleeper?.cwd || deps.agy.sessionCwd(session)
  const cwd = rawCwd && statSync(rawCwd, { throwIfNoEntry: false })?.isDirectory() ? rawCwd : undefined
  const ran = await runHere(program, argv, process.env, cwd)
  if (ran.error) throw new Error(`${program} did not start: ${messageOf(ran.error)}`)
  process.exit(ran.code)
}

/** Resume in the rollout's Codex home, even when launched from a new shell. */
async function resumeCodex(): Promise<void> {
  const args = rest.filter(word => word !== '--codex')
  const id = args[0]
  if (args.length !== 1 || !id || !isCodexSession(id)) throw new Error('usage: board resume --codex <conversation id>')
  const transcript = deps.codex.transcriptPath(id)
  if (!transcript) throw new Error(`no Codex conversation ${id}`)
  const sleeper = Object.values(peekAgySleepers(wakeCodexFile())).find(
    s => s.session.toLowerCase() === id.toLowerCase(),
  )
  const rawCwd = (await deps.codex.cwdOf(id)) || sleeper?.cwd
  const cwd = rawCwd && statSync(rawCwd, { throwIfNoEntry: false })?.isDirectory() ? rawCwd : undefined
  const command = codexCommand(cfg.launch?.codex)
  const [program = CODEX_AGENT, ...options] = command
  const argv = [...options, ...(await noDaemonArgs(command)), 'resume', id.toLowerCase()]
  const ran = await runHere(program, argv, { ...process.env, CODEX_HOME: codexHomeOf(transcript) }, cwd)
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
  // On a node (#786), another machine's session by its key: archived there, through the master.
  const node = nodeConfig(cfg.node)
  if (node && (await import('./node-remote-cli.ts')).foreignTargets([target], node.id)) return archiveUp(target)
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
  // On a node (#798), none of this computer's: another machine's by its id or name, through the master.
  if (!found.length && node) {
    const up = await foreignTargetUp(target, node.id)
    if (up) return archiveUp(up)
  }
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

/**
 * On a node (#798): the sessions of other machines as the master's `board agents --json` lists them,
 * asked once as this session through the uplink, as a lookup of a target by its id or name that
 * gives its key in this node's terms (`@<device>:<key>`), null when none fits. null instead of the
 * lookup when this is no session (the uplink asks as one). The master not answering is its own
 * error, never "no session".
 */
async function foreignLookup(self: string): Promise<((target: string) => string | null) | null> {
  const from = await ownSession().catch(() => null)
  if (!from?.key) return null
  const [{ callBoard }, { boardCall, foreignMatch }] = await Promise.all([
    import('./node-call.ts'),
    import('./node-remote-cli.ts'),
  ])
  const asked = "the board's computer could not be asked for other machines' sessions"
  const answer = await callBoard(cfg.port)({
    cmd: 'agents',
    argv: ['--json'],
    session: from.key,
    lane: null,
    files: [],
  })
  if (!answer) throw new Error(`${asked}: ${NO_BOARD}`)
  if (answer.state !== 'answered') throw new Error(`${asked}: it is not reachable from here now`)
  if (answer.code !== 0) throw new Error(`${asked}: ${answer.err.join('; ') || `exit ${answer.code}`}`)
  let views: unknown
  try {
    views = JSON.parse(answer.out.join('\n'))
  } catch {
    throw new Error(`${asked}: its answer could not be read`)
  }
  // The master's own sessions go by its id, which this node's payload carries (core/board-slices.ts).
  const relayed = (await boardCall(cfg.port, '/api/board', { ms: 5000 }))?.body.relayedDevices
  const masterId = isRecord(relayed) && typeof relayed.master === 'string' ? relayed.master : ''
  return target => {
    const m = foreignMatch(views, target, self, masterId)
    if (m && 'error' in m) throw new Error(m.error)
    return m?.key ?? null
  }
}

/** One target of another machine's (#798), as foreignLookup finds it; null when none is or this is no session. */
async function foreignTargetUp(target: string, self: string): Promise<string | null> {
  const look = await foreignLookup(self)
  return look ? look(target) : null
}

/**
 * On a node (#798): `targets` with each that no session of this computer answers to (by key,
 * session id, pane or name) and that has no device prefix yet named as another machine's session,
 * when one fits; the others as they came. The master is asked only when such a target is there.
 */
async function foreignTargetsUp(targets: readonly string[], self: string): Promise<string[]> {
  const { parseNodeKey } = await import('../core/node-key.ts')
  const items = await collect(deps)
  const here = (t: string): boolean => {
    const want = t.toLowerCase()
    return items.some(i => [i.key, i.session, i.pane, i.name, i.autoName].some(v => !!v && v.toLowerCase() === want))
  }
  const unknown = targets.filter(t => !parseNodeKey(t) && !here(t))
  if (!unknown.length) return [...targets]
  const look = await foreignLookup(self)
  if (!look) return [...targets]
  return targets.map(t => (unknown.includes(t) ? (look(t) ?? t) : t))
}

/** `board archive` of another machine's session from a node (#786): through the master, which hands it on. */
async function archiveUp(key: string): Promise<void> {
  const { boardCall, relayLine } = await import('./node-remote-cli.ts')
  const r = await boardCall(cfg.port, '/api/archive', { method: 'POST', body: { op: 'archive', keys: [key] } })
  if (!r) throw new Error(NO_BOARD)
  const plain = relayLine(r)
  if (plain) throw new Error(`${key} stays on the board: ${plain}`)
  const failed = Array.isArray(r.body.failed) ? r.body.failed.filter(isRecord) : []
  if (r.body.ok !== true || failed.length)
    throw new Error(`${key} stays on the board: ${String(failed[0]?.error ?? r.body.error ?? r.status)}`)
  console.log(`ok · archived ${key}: the user can bring it back from the board's archive (Archive on the toolbar)`)
}

/** `board sleep` naming another machine's sessions from a node (#786): through the master, which hands each to its machine. */
async function sleepUp(targets: string[]): Promise<void> {
  const { boardCall, relayLine } = await import('./node-remote-cli.ts')
  const r = await boardCall(cfg.port, '/api/sleep', {
    method: 'POST',
    body: { targets, ...(whenFree && { whenFree: true }) },
  })
  if (!r) throw new Error(NO_BOARD)
  const plain = relayLine(r)
  if (plain) throw new Error(`${plain}; nothing was put to sleep`)
  const results = (Array.isArray(r.body.results) ? r.body.results.filter(isRecord) : []) as unknown as SleepOutcome[]
  if (!results.length) throw new Error(`the board said ${r.status}${r.body.error ? `: ${String(r.body.error)}` : ''}`)
  const asleep = results.filter(o => o.result === 'asleep').length
  console.log([`ok · ${asleep} put to sleep of ${results.length}`, ...results.map(sleepLine)].join('\n'))
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
  const targets = [...words, ...(target ? [target] : [])]
  if (!targets.length && !self)
    throw new Error(
      'usage: board sleep <id|name|pane>... [--when-free] [--self]: the sessions to put to sleep (a name with spaces in quotes; --self: this one, once its turn is over)',
    )
  // On a node (#786), another machine's sessions by their keys: put to sleep there, through the master.
  const node = nodeConfig(cfg.node)
  if (node && !self) {
    const { foreignTargets } = await import('./node-remote-cli.ts')
    if (foreignTargets(targets, node.id)) return sleepUp(targets)
    // A bare id or name of another machine's session (#798): found through the master, put to sleep there.
    const up = await foreignTargetsUp(targets, node.id)
    if (foreignTargets(up, node.id)) return sleepUp(up)
  }
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
  const nudge = self && from ? await caseNudge(from.key) : ''
  console.log([`ok · ${head.filter(Boolean).join(', ')}${hint}${note}${nudge}`, ...results.map(sleepLine)].join('\n'))
}

/** One session's line for `board move`: who, then moved, moved once free, or refused and why. */
function moveLine(o: MoveOutcome, profile: string): string {
  const who = o.name ? `${o.name}${o.pane ? ` (${o.pane})` : ''}` : `"${o.target}"`
  if (o.result === 'moved') return `${who}: moved to ${profile}${o.notes?.length ? ` · ${o.notes.join(' · ')}` : ''}`
  const s = o.sleep
  if (o.result === 'scheduled' && s)
    return `${who}: ${keptBy(s)}; goes to sleep once it is free, then moves to ${profile}${s.again ? ' (asked before)' : ''} · cancel: board unschedule ${s.id}`
  if (!s) return `${who}: refused, ${o.why ?? ''}`
  // Held for what passes: put to sleep by hand, or moved once it is free.
  const passes = ['busy', 'dialog', 'draft', 'tasks'].includes(s.why ?? '')
  const hint = passes ? `; put it to sleep first (board sleep ${o.key ?? o.target}), or add --when-free` : ''
  return `${who}: refused, ${keptBy(s)}${hint}`
}

/** What a device move would take, `--dry-run`: where it would run, the changes that would go with it. */
function planLines(o: Record<string, unknown>, where: string): string {
  const who = typeof o.name === 'string' && o.name ? o.name : `"${String(o.target)}"`
  const p = isRecord(o.plan) ? o.plan : null
  if (o.result !== 'plan' || !p) return `${who}: would be refused, ${String(o.why ?? '')}`
  const kb = (n: unknown): string => `${Math.max(1, Math.round(Number(n) / 1024))} KB`
  const changes = (Array.isArray(p.changes) ? p.changes : []).filter(isRecord)
  const deleted = Array.isArray(p.deleted) ? p.deleted.map(String) : []
  return [
    `${who}: would move to ${where}, into ${String(p.cwd)} (${String(p.address)} at ${String(p.branch)}); ${String(p.files)} file(s) of its own, ${kb(p.bytes)}`,
    changes.length || deleted.length
      ? `  with ${changes.length + deleted.length} uncommitted change(s):`
      : '  nothing uncommitted goes with it',
    ...changes.map(c => `    ${String(c.path)} (${kb(c.size)})`),
    ...deleted.map(d => `    ${d} (deleted)`),
  ].join('\n')
}

/**
 * `board move <id|name|pane>... --device <id|local>` (#616): the sessions moved to another device by
 * the running board, which must be the master (services/nodes/move-device.ts); a line for each. A
 * session at work is refused, never waited for: its conversation must be whole before it is copied.
 */
async function moveDevice(targets: string[], device: string, dryRun: boolean): Promise<void> {
  if (whenFree)
    throw new Error(
      '--when-free is for a move to another profile; a move to another device takes a session that is free',
    )
  const webPort = Number(cfg.port) || 12422
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ targets, device, ...(dryRun && { dryRun: true }) }),
      // Each session's files cross the link and its start is waited for: minutes, not seconds.
      signal: AbortSignal.timeout(30 * 60_000),
    })
  } catch {
    throw new Error(NO_BOARD)
  }
  const r: unknown = await res.json().catch(() => null)
  if (!res.ok || !isRecord(r) || !Array.isArray(r.results))
    throw new Error(`the board said ${res.status}${isRecord(r) && r.error ? `: ${String(r.error)}` : ''}`)
  const results = r.results.filter(isRecord)
  const moved = results.filter(o => o.result === 'moved').length
  const where = device === 'local' ? 'this computer' : device
  if (dryRun) return console.log(results.map(o => planLines(o, where)).join('\n'))
  const lines = results.map(o => {
    const who = typeof o.name === 'string' && o.name ? o.name : `"${String(o.target)}"`
    const notes = Array.isArray(o.notes) && o.notes.length ? ` · ${o.notes.map(String).join(' · ')}` : ''
    return o.result === 'moved'
      ? `${who}: moved to ${where}${o.newKey ? ` (${String(o.newKey)})` : ''}${notes}`
      : `${who}: refused, ${String(o.why ?? '')}`
  })
  const refused = results.length - moved
  console.log([`ok · ${moved} moved to ${where}${refused ? `, ${refused} refused` : ''}`, ...lines].join('\n'))
}

/**
 * `board move <id|name|pane>... --profile <id> [--when-free]` (#250): the sessions moved to another
 * Claude profile, keeping their conversation (services/move.ts); a line for each. In English for
 * agents, whatever language the board speaks.
 */
async function move(): Promise<void> {
  const asked = parseMoveAny([...rest, ...(target ? [target] : [])])
  if (asked.device !== undefined) {
    // On a node (#798): a bare id or name of another machine's session goes by its key, which the relay takes up.
    const node = nodeConfig(cfg.node)
    const targets = node ? await foreignTargetsUp(asked.targets, node.id) : asked.targets
    return moveDevice(targets, asked.device, asked.dryRun)
  }
  const { targets, profile } = asked
  const from = await ownSession()
  const items = await collect(deps)
  const results = await moveMany(deps, items, targets, { profile, whenFree, by: 'agent', ...(from && { from }) })
  const count = (result: MoveOutcome['result']): number => results.filter(o => o.result === result).length
  const head = [
    `${count('moved')} moved to ${profile}`,
    count('scheduled') && `${count('scheduled')} once free`,
    count('refused') && `${count('refused')} refused`,
  ]
  const note = count('scheduled') ? await schedulerNote() : ''
  console.log([`ok · ${head.filter(Boolean).join(', ')}${note}`, ...results.map(o => moveLine(o, profile))].join('\n'))
}

/**
 * `board sleep <pane> --pi-session <file>` (#178): a pane at its shell where a pi session was
 * stopped by hand, taken by the board's wake as that session asleep there: its card shows it
 * sleeping and wakes it, as if wake had put it to sleep. Only through the board's own wake.
 */
async function adoptPi(): Promise<void> {
  const pane = words[0] ?? ''
  const file = piSessionFile ?? ''
  if (words.length !== 1 || !pane || !isPiSessionFile(file))
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
 * `board remote [on | off | pwa on|off | owner-admin on|off | approve <id> | deny <id> | revoke <id> | desk <id> [off]]`: the remote mode
 * (core/remote.ts). On and off edit config.json (off takes back `tailscale serve` too); `pwa`
 * sets serve up for the board in a phone's browser (core/pwa.ts) and shows its address and QR
 * code; `owner-admin` allows the owner's own strong login to use admin panels over remote listeners
 * on a headless master (#694); the rest goes through the running board, which holds the requests to pair. `desk` marks a
 * paired device as the owner's desk (RemoteDevice.desk), `desk <id> off` takes it back. Without an
 * argument: where it listens, who waits, who is paired.
 */
async function remote(): Promise<void> {
  const [op = 'status', id = ''] = words
  const usage =
    'usage: board remote [on | off | pwa on|off | owner-admin on|off | approve <id> | deny <id> | revoke <id> | desk <id> [off]]'
  const webPort = Number(cfg.port) || 12422
  if (op === 'owner-admin') {
    if (id !== 'on' && id !== 'off') throw new Error(usage)
    const r = setRemoteOwnerAdmin(id === 'on')
    if (!r.ok) throw new Error(r.error)
    return console.log(id === 'on' ? 'ok · owner-admin on' : 'ok · owner-admin off')
  }
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
  if (op === 'desk') {
    if (!id || (words[2] !== undefined && words[2] !== 'off')) throw new Error(usage)
    const off = words[2] === 'off'
    const body = JSON.stringify({ op: off ? 'undesk' : 'desk', id })
    const r = await call({ method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body })
    if (!isRecord(r) || r.ok !== true) {
      const why = isRecord(r) && typeof r.error === 'string' ? ` (${r.error})` : ''
      const what = off ? `no device ${id}` : `no paired browser ${id} to make a desk`
      throw new Error(`${what}${why}: \`board remote\` lists them`)
    }
    if (off) return console.log(`ok · ${id} is a phone again`)
    console.log(`ok · ${id} is your desk: Go to herdr and answering phones work from it; reload its board`)
    const view = (await call().catch(() => null)) as Partial<RemoteView> | null
    let host: string | null = null
    try {
      host = view?.url ? new URL(view.url).hostname : null
    } catch {}
    for (const line of deskSteps(userInfo().username, host)) console.log(line)
    return
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
  if (!view.on) {
    console.log('remote off · `board remote on` lets a paired phone use this board over Tailscale')
    if (view.ownerAdmin) console.log('owner-admin: on')
    return
  }
  console.log(`remote on · ${view.url ?? `not listening: ${view.error ?? 'starting'}`}`)
  if (view.ownerAdmin) console.log('owner-admin: on')
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
      `paired: ${d.id} "${d.name}"${d.kind === 'browser' ? ' (browser)' : ''} on ${d.device} (${d.login})${d.seenAt ? `, seen ${stamp(d.seenAt)}` : ''}${d.desk ? ' · desk' : ''}`,
    )
}

/**
 * `board node [token [--name <master>] | forget <id>]` (#498): this board as a node, set up by hand
 * until the install exists. Without an argument: the master door, on when it answers its hello on
 * 127.0.0.1:<node.port>, and the masters by name and when each was last seen. `token` adds a master
 * to masters.json (adapters/node-store.ts) and prints its token, the one time it is shown; `forget`
 * takes a master's token back, and the door ends its streams. A board without a `node` that checks
 * out says so in one line, and reads nothing else.
 */
async function nodeCmd(): Promise<void> {
  const [op = 'status', id = ''] = words
  const usage = 'usage: board node [token [--name <master>] | forget <id> | leave [<master id>]]'
  const { nodeConfig, nodeProblems } = await import('../core/nodes.ts')
  const node = nodeConfig(cfg.node)
  if (!node) {
    const problems = nodeProblems(cfg.node).map(p => `${p.key}: ${p.why}`)
    return console.log(
      problems.length
        ? `this board is not a node: config.json's \`node\` does not check out (${problems.join(', ')})`
        : 'this board is not a node: config.json has no `node`',
    )
  }
  const { createNodeStore, masterName } = await import('../adapters/node-store.ts')
  const store = createNodeStore()
  if (op === 'token') {
    if (id) throw new Error(usage)
    const name = masterName(forkName ?? 'master')
    if (!name) throw new Error("a master's name: up to 64 printable characters")
    const { master, token } = store.add(name, 'hand')
    console.log(`ok · master ${master.id} "${master.name}" added; its token, shown this once:`)
    return console.log(token)
  }
  if (op === 'forget') {
    if (!id || words.length > 2) throw new Error(usage)
    if (!store.forget(id)) throw new Error(`no master ${id}: \`board node\` lists them`)
    return console.log(`ok · forgot master ${id}: its token no longer opens the door`)
  }
  if (op === 'leave') {
    // The node's own half of a revoke (#510, design 11.4), with no master reachable: one master,
    // or the only one when none is named.
    if (words.length > 2) throw new Error(usage)
    const masters = store.list()
    const which = id || (masters.length === 1 ? (masters[0]?.id ?? '') : '')
    if (!which)
      throw new Error(
        masters.length ? 'several masters: name the one to leave (`board node` lists them)' : 'no master to leave',
      )
    if (!store.forget(which)) throw new Error(`no master ${which}: \`board node\` lists them`)
    console.log(`ok · left master ${which}: its token no longer opens the door and its streams end`)
    // What that master's bundles gave (#609): the secrets of #604, the GitHub login, the identity.
    const out = await takeOutMaster(which)
    const said = [
      ...(out.env.length ? [`variables ${out.env.join(', ')}`] : []),
      ...(out.files.length ? [`files ${out.files.join(', ')}`] : []),
      ...(out.logins.length ? [`the GitHub login for ${out.logins.join(', ')}`] : []),
      ...(out.identity ? ['the git identity'] : []),
    ]
    if (said.length) console.log(`taken out what it gave: ${said.join('; ')}`)
    if (out.failed?.length)
      console.log(`could not take out: ${out.failed.join(', ')} (\`board node leave\` again tries once more)`)
    return
  }
  if (op !== 'status' || words.length > 0) throw new Error(usage)
  let on = false
  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/api/hello`, { signal: AbortSignal.timeout(1500) })
    const hello: unknown = await res.json()
    on = isRecord(hello) && isRecord(hello.node) && hello.node.id === node.id
  } catch {}
  console.log(
    on
      ? `node ${node.id} · door on 127.0.0.1:${node.port}`
      : `node ${node.id} · door off: nothing of this board answers on 127.0.0.1:${node.port} (does the board run?)`,
  )
  const masters = store.list()
  if (!masters.length) return console.log('no master yet · `board node token --name <master>` adds one')
  for (const m of masters)
    console.log(
      `master ${m.id} "${m.name}" · paired ${stamp(m.pairedAt)} · ${m.seenAt ? `seen ${stamp(m.seenAt)}` : 'not seen yet'}`,
    )
}

/**
 * `board node leave` (#609, design 11.4): what the master's bundles gave this node, still as they gave
 * it, taken out here as the running board's leave route does: the variables and secret files of #604,
 * the GitHub login, the git identity.
 */
async function takeOutMaster(
  master: string,
): Promise<{ env: string[]; files: string[]; logins: string[]; identity: boolean; failed?: string[] }> {
  const [{ nodeDir }, { writeSink }, { auditBundle }, { gitTools }, { createNodeGit }, { createNodeSecrets }] =
    await Promise.all([
      import('../adapters/node-store.ts'),
      import('../adapters/secret-sinks.ts'),
      import('../services/secrets.ts'),
      import('../adapters/git-access.ts'),
      import('../services/node/git-access.ts'),
      import('../services/node/secrets.ts'),
    ])
  const log = (): void => {}
  const git = createNodeGit({ dir: nodeDir(), tools: gitTools(), audit: auditBundle, log })
  const secrets = createNodeSecrets({
    dir: nodeDir(),
    profiles: () => deps.profiles().list,
    write: writeSink,
    audit: auditBundle,
    log,
  })
  const [s, g] = await Promise.all([secrets.leave(master), git.leave(master)])
  return { ...s, ...g }
}

const NO_BOARD = 'the board does not run: open it first (herdr plugin action invoke agent-board.open)'

/** `board master handover | rollback | status` (#697): guided handover of the master role. */
async function masterCmd(): Promise<void> {
  const { formatHandoverPlan, formatHandoverResult, MASTER_USAGE, parseMasterCliArgs } = await import(
    '../core/master-handover.ts'
  )
  const parsed = parseMasterCliArgs(flagWords)
  if (!parsed.ok) throw new Error(parsed.error)
  const webPort = Number(cfg.port) || 12422
  const base = `http://127.0.0.1:${webPort}/api/nodes/handover`
  const cmd = parsed.cmd

  if (cmd.op === 'status') {
    let view: unknown = null
    let statusCode: number | null = null
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) })
      statusCode = res.status
      view = res.ok ? await res.json() : null
    } catch {}
    if (!view) {
      const { latestHandoverBackupId, readHandoverState } = await import('../adapters/handover-store.ts')
      const state = readHandoverState()
      const backup = latestHandoverBackupId()
      const running = statusCode !== null
      if (cmd.json) return console.log(JSON.stringify({ running, status: statusCode, state, backup }, null, 2))
      const prefix = running ? 'board is running (no master handover configured)' : 'board is not running'
      if (!state && !backup) return console.log(`${prefix}; no handover state recorded`)
      return console.log(
        `${prefix} · state: ${state ? `${state.id} (${state.role}, ${state.phase})` : 'none'}${backup ? ` · backup: ${backup}` : ''}`,
      )
    }
    if (cmd.json) return console.log(JSON.stringify(view, null, 2))
    const v = view as {
      phase?: string
      id?: string | null
      target?: string | null
      canRollback?: boolean
      error?: string | null
      state?: { phase?: string } | null
    }
    const phaseText = v.phase && v.phase !== 'idle' ? v.phase : (v.state?.phase ?? 'idle')
    console.log(
      `handover ${phaseText}${v.id ? ` (${v.id})` : ''}${v.target ? ` · target ${v.target}` : ''}${v.canRollback ? ' · rollback available' : ''}${v.error ? ` · error: ${v.error}` : ''}`,
    )
    return
  }

  const promptSudo = async (promptText: string): Promise<string | null> => {
    if (!process.stdin.isTTY) return null
    const { readHidden } = await import('../adapters/stdin.ts')
    const [pw = ''] = await readHidden([promptText])
    return pw || null
  }

  if (cmd.op === 'rollback') {
    const sendRollback = async (sudoPassword?: string): Promise<Record<string, unknown> | null> => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({
          op: 'rollback',
          ...(cmd.id && { id: cmd.id }),
          ...(cmd.localOnly && { localOnly: true }),
          ...(cmd.discardSinceCommit && { discardSinceCommit: true }),
          ...(sudoPassword !== undefined && { sudoPassword }),
        }),
        signal: AbortSignal.timeout(180_000),
      })
      return (await res.json().catch(() => null)) as Record<string, unknown> | null
    }
    let body: Record<string, unknown> | null = null
    try {
      body = await sendRollback()
      if (body && body.ok !== true && body.need === 'sudoPassword' && !cmd.json) {
        const pw = await promptSudo('Sudo password: ')
        if (pw) body = await sendRollback(pw)
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(
          'rollback request timed out while the board may still be running it; check "board master status"',
        )
      }
      if (!cmd.localOnly) {
        throw new Error(
          `the board does not answer on port ${webPort}; pass --local-only for offline local restore\n${MASTER_USAGE}`,
        )
      }
      const { latestHandoverBackupId, readHandoverState, restoreLocalBackup, writeHandoverState } = await import(
        '../adapters/handover-store.ts'
      )
      const state = readHandoverState()
      if (state?.role === 'new-master' && state.phase === 'committed' && !cmd.discardSinceCommit) {
        throw new Error(
          'handover is already committed; rolling back will discard all changes written on this master since commit (pass --discard-since-commit to confirm)',
        )
      }
      const id = cmd.id ?? state?.id ?? latestHandoverBackupId()
      if (!id) throw new Error('no handover backup found on disk')
      const scope =
        state?.role === 'old-master'
          ? state.phase === 'committed'
            ? 'old-master-committed'
            : 'old-master-precommit'
          : 'all'
      const res = await restoreLocalBackup(id, { scope })
      if (state && state.id === id) writeHandoverState({ ...state, phase: 'rolled-back', at: Date.now() })
      const out = { ok: true, id, ...res }
      if (cmd.json) return console.log(JSON.stringify(out, null, 2))
      return console.log(
        `ok · rolled back local state from backup ${id} (${res.restored} restored, ${res.removed} removed)`,
      )
    }
    if (!body) throw new Error('empty response from board')
    if (cmd.json) console.log(JSON.stringify(body, null, 2))
    else if (body.ok)
      console.log(
        `ok · rolled back handover ${String(body.id ?? '')} (${String(body.restored ?? 0)} restored, ${String(body.removed ?? 0)} removed)`,
      )
    else console.log(`failed · rollback: ${String(body.error ?? 'unknown error')}`)
    if (!body.ok) process.exitCode = 1
    return
  }

  const sendHandover = async (
    sudoPassword?: string,
  ): Promise<{ status: number; data: Record<string, unknown> | null }> => {
    const payload = {
      op: cmd.dryRun ? 'check' : 'run',
      to: cmd.to,
      ...(cmd.reverseLink !== undefined && { reverseLink: cmd.reverseLink }),
      ...(cmd.nodePort !== undefined && { nodePort: cmd.nodePort }),
      ...(cmd.allowOfflineNodes && { allowOfflineNodes: true }),
      ...(sudoPassword !== undefined && { sudoPassword }),
    }
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    }).catch(err => {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(
          'handover request timed out while the board may still be running it; check "board master status"',
        )
      }
      throw new Error(`the board does not answer on port ${webPort}`)
    })
    const jsonBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, data: jsonBody }
  }

  let { status, data } = await sendHandover()
  if (data && data.need === 'sudoPassword' && !cmd.json && !cmd.dryRun) {
    const pw = await promptSudo('Sudo password on target: ')
    if (pw) ({ status, data } = await sendHandover(pw))
  }
  if (!data) throw new Error(`board answered ${status}`)

  if (cmd.dryRun) {
    const plan = data.plan as Parameters<typeof formatHandoverPlan>[0] | undefined
    if (!plan) throw new Error(String(data.error ?? `board answered ${status}`))
    if (cmd.json) console.log(JSON.stringify(plan, null, 2))
    else console.log(formatHandoverPlan(plan).join('\n'))
    if (!plan.ok) process.exitCode = 1
    return
  }

  if (cmd.json) console.log(JSON.stringify(data, null, 2))
  else console.log(formatHandoverResult(data as Parameters<typeof formatHandoverResult>[0]).join('\n'))
  if (!data.ok) process.exitCode = 1
}

/**
 * `board nodes [token <id> | key <id> | sync <id> [<profile>]]` (#499): this board as a master. Without an argument: its
 * devices in order with their link's state, from the running board's GET /api/nodes, and what of
 * config.json's `nodes` does not check out. `token` stores the token a node printed (`board node
 * token` there), read from stdin, and has the running board try that link again at once. `key`
 * makes a device's ssh link key when it has none (adapters/ssh.ts generateKey, its rights set on
 * Windows) and prints the public half, for the node's fenced user. `sync`: nodesSync. `secret`: nodesSecret. A
 * board without `nodes` says it is no master in one line, and reads nothing else.
 */
async function nodesCmd(): Promise<void> {
  const [op = 'status', id = ''] = words
  const usage =
    'usage: board nodes [token <id> | key <id> | sync <id> [<profile>] | update <id> | secret <id> <sink> | revoke <id> [--keep-running] [--forget]]'
  const { nodesConfig } = await import('../core/nodes.ts')
  const nodes = nodesConfig(cfg.nodes, (await import('node:os')).hostname())
  // On a node (#786): the master's devices, read through the relay; update and sync asked of it.
  if (!nodes && isNodeOnly(cfg)) return nodesOnNode(op, id)
  if (!nodes) return console.log('this board is not a master: config.json has no `nodes`')
  const webPort = Number(cfg.port) || 12422
  const device = (): string => {
    if (!id || words.length > 2) throw new Error(usage)
    if (id === 'local' || !nodes.devices[id]?.link)
      throw new Error(`no device ${id} with a link: \`board nodes\` lists them`)
    return id
  }
  const { createDeviceStore } = await import('../adapters/node-store.ts')
  if (op === 'token') {
    const dev = device()
    // never an argument (it would stay in the shell's history and the process list), never typed on a terminal here
    if (process.stdin.isTTY) throw new Error(`${usage}: the token comes on stdin`)
    const { readStdin } = await import('../adapters/stdin.ts')
    const token = ((await readStdin()).split(/\r?\n/)[0] ?? '').trim()
    createDeviceStore().setToken(dev, token)
    let told = false
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ op: 'retry', id: dev }),
        signal: AbortSignal.timeout(1500),
      })
      told = res.ok
      await res.body?.cancel()
    } catch {}
    return console.log(`ok · token for ${dev} stored${told ? '; the board tries the link again now' : ''}`)
  }
  if (op === 'sync') {
    const profile = words[2]
    if (!id || words.length > 3) throw new Error(usage)
    if (id === 'local' || !nodes.devices[id]?.link)
      throw new Error(`no device ${id} with a link: \`board nodes\` lists them`)
    return nodesSync(webPort, id, profile)
  }
  if (op === 'secret') {
    const sink = words[2]
    if (!id || !sink || words.length > 3) throw new Error(usage)
    if (id === 'local' || !nodes.devices[id]?.link)
      throw new Error(`no device ${id} with a link: \`board nodes\` lists them`)
    return nodesSecret(webPort, id, sink, nodes.devices[id]?.sinks)
  }
  if (op === 'update') {
    if (!id || words.length > 2) throw new Error(usage)
    if (id === 'local' || !nodes.devices[id]?.link)
      throw new Error(`no device ${id} with a link: \`board nodes\` lists them`)
    return nodesUpdate(webPort, id)
  }
  if (op === 'revoke') {
    const flags = words.slice(2)
    if (!id || flags.some(f => f !== '--keep-running' && f !== '--forget')) throw new Error(usage)
    if (id === 'local' || !nodes.devices[id]?.link)
      throw new Error(`no device ${id} with a link: \`board nodes\` lists them`)
    return nodesRevoke(webPort, id, !flags.includes('--keep-running'), flags.includes('--forget'))
  }
  if (op === 'key') {
    const dev = device()
    if (nodes.devices[dev]?.link?.kind !== 'ssh')
      throw new Error(`${dev} has no ssh link: only an ssh link takes a key`)
    const key = createDeviceStore().keyPath(dev)
    const { generateKey, publicKeyOf } = await import('../adapters/ssh.ts')
    const { existsSync } = await import('node:fs')
    const made = existsSync(key) ? await publicKeyOf(key) : await generateKey(`agent-board ${nodes.id} to ${dev}`, key)
    if (!made.ok) throw new Error(made.error)
    return console.log(made.publicKey)
  }
  if (op !== 'status' || words.length > 0) throw new Error(usage)
  let view: unknown = null
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, { signal: AbortSignal.timeout(1500) })
    view = res.ok ? await res.json() : null
  } catch {}
  const lines: string[] = []
  const devices = isRecord(view) && Array.isArray(view.devices) ? view.devices.filter(isRecord) : null
  if (!devices) {
    lines.push(`master ${nodes.id} · ${NO_BOARD}`)
    for (const dev of nodes.order) {
      const title = nodes.devices[dev]?.title
      const defaultTitle = dev === 'local' ? nodes.id : dev
      const head = `${dev}${title && title !== dev && title !== defaultTitle ? ` "${title}"` : ''}`
      lines.push(`${head} · ${dev === 'local' ? 'this computer' : nodes.devices[dev]?.link?.kind}`)
    }
  } else {
    lines.push(`master ${nodes.id}`)
    for (const d of devices) lines.push(deviceLine(d, nodes.id))
  }
  for (const p of nodes.problems) lines.push(`problem: ${p.device ? `${p.device} ` : ''}${p.key}: ${p.why}`)
  console.log(lines.join('\n'))
}

/**
 * `board nodes revoke <id> [--keep-running] [--forget]` (#510, design 11.4): the running board marks
 * the device revoked, so nothing more is placed there, and tells the node to put its sessions to
 * sleep (not with --keep-running) and forget this board; a node not reachable is told when its link
 * comes back. --forget drops the token and link key now without telling it.
 */
/** Why an update of a node did not happen (#590), by the code services/nodes/update.ts or the node gave. */
const UPDATE_WHY: Record<string, string> = {
  offline: 'the node is not reachable',
  busy: 'an update of it is under way already',
  revoked: 'the device is revoked',
  'too-big': 'the archive is larger than the node takes',
  token: "the node did not take this board's token",
  update: 'the node could not read the request',
  loads: 'the new copy does not load on the node; the old one stays',
  node: 'the node gave no reason',
  'no-checkout':
    'this board has no git checkout to send its code from (installed from an archive, or git is missing): update the node by hand',
  'git-archive': "git could not make the archive of this board's commit",
  platform: 'the node runs an older board on Windows, which does not update itself: update it by hand once',
  restart: 'its board does not run in its herdr pane (run.ts), so nothing would start it again: update it by hand',
  'not-built': 'its board is older than updates over the link: update it by hand once',
  sha256: 'the archive arrived changed: try again',
  blob: 'the node lost the archive before the update: try again',
  archive: 'the node refused the archive',
  unpack: 'the node could not unpack the new copy; the old one stays',
  install: 'bun install --production failed on the node (it needs the network); the old copy stays',
  swap: 'the node could not swap the new copy in; the old one stays',
  'not-back': 'the node did not come back on the new commit within 3 minutes',
  timeout: 'the node did not answer in time',
  git: "git failed in the node's checkout; the checkout is as it was",
  'git-dirty': "the node's checkout has changes: commit or stash them there, or update it by hand",
  'git-fetch': "the node's checkout could not fetch from its remote; the checkout is as it was",
  'git-ahead': "the node's checkout has commits on no remote: push them, or update it by hand",
  'git-commit': "this board's commit is not on the node's remote yet: push it first",
  'git-diverged': "the node's branch does not lead to this board's commit: update it by hand",
  'git-locks': "a lock file is added or removed: update the node's checkout by hand",
  'kept-old': 'a folder beside the plugin on the node holds a git checkout and is kept: move it away by hand',
}

/**
 * `board nodes update <id>` (#590, docs/design/nodes 6.5): the running board ships its commit to
 * the device now, a session there in a turn or not, and says how it went.
 */
/**
 * `board nodes` on a node (#786): the master's devices, read through the relay, and Update and
 * Sync asked of the master; adding, revoking and tokens stay on the master.
 */
async function nodesOnNode(op: string, id: string): Promise<void> {
  const webPort = Number(cfg.port) || 12422
  const usage = 'usage on a node: board nodes [update <id> | sync <id> [<profile>]]; the rest runs on the master'
  if (op === 'update') {
    if (!id || words.length > 2) throw new Error(usage)
    return nodesUpdate(webPort, id)
  }
  if (op === 'sync') {
    if (!id || words.length > 3) throw new Error(usage)
    return nodesSync(webPort, id, words[2])
  }
  if (op !== 'status' || words.length > 0) throw new Error(usage)
  const { boardCall, relayLine } = await import('./node-remote-cli.ts')
  const r = await boardCall(webPort, '/api/nodes', { ms: 5000 })
  if (!r) throw new Error(NO_BOARD)
  const plain = relayLine(r)
  if (plain) throw new Error(plain)
  const devices = Array.isArray(r.body.devices) ? r.body.devices.filter(isRecord) : null
  if (!devices) throw new Error(`the board said ${r.status}${r.body.error ? `: ${String(r.body.error)}` : ''}`)
  // In this computer's terms (core/board-slices.ts nodesAnswerForNode): it is `local`, the master its id.
  const masterId = typeof r.body.master === 'string' ? r.body.master : ''
  const self = nodeConfig(cfg.node)?.id ?? 'local'
  console.log(
    [
      `master ${masterId}`,
      ...devices.map(d =>
        d.id === 'local'
          ? `${self} · this computer`
          : d.id === masterId
            ? `${masterId} · the master · ${String(isRecord(d.link) ? d.link.state : '')}`
            : deviceLine(d, masterId),
      ),
    ].join('\n'),
  )
}

async function nodesUpdate(webPort: number, id: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'update', id }),
      // The board's own limits for the upload and the node's install, and a minute over.
      signal: AbortSignal.timeout(18 * 60_000),
    })
  } catch {
    throw new Error(NO_BOARD)
  }
  const body: unknown = await res.json().catch(() => null)
  const a = isRecord(body) ? body : {}
  const commit = typeof a.commit === 'string' ? a.commit.slice(0, 12) : ''
  if (a.ok === true && a.current === true) return console.log(`ok · ${id} runs this board's commit ${commit} already`)
  if (a.ok === true)
    return console.log(`ok · ${id} took ${commit}: its board restarts on it, its sessions keep running`)
  const error = typeof a.error === 'string' ? a.error : String(res.status)
  const detail = typeof a.detail === 'string' ? ` (${a.detail.split('\n').slice(-3).join(' ').slice(0, 300)})` : ''
  console.log(`not updated · ${id}: ${UPDATE_WHY[error] ?? error}${detail}`)
  process.exitCode = 1
}

async function nodesRevoke(webPort: number, id: string, sleep: boolean, forget: boolean): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'revoke', id, sleep, forget }),
      signal: AbortSignal.timeout(75_000),
    })
  } catch {
    throw new Error(NO_BOARD)
  }
  const body: unknown = await res.json().catch(() => null)
  const a = isRecord(body) ? body : {}
  if (!res.ok) throw new Error(`${id} was not revoked: ${typeof a.error === 'string' ? a.error : res.status}`)
  const s = isRecord(a.sessions) ? a.sessions : null
  const sessions = s ? `, ${String(s.slept)} of its sessions put to sleep (${String(s.kept)} kept awake),` : ''
  console.log(
    a.told === true
      ? `ok · ${id} revoked: the node was told${sleep ? sessions : ''} and forgot this board`
      : forget
        ? `ok · ${id} revoked: its token and key dropped, the node was not told`
        : `ok · ${id} revoked: nothing more goes there; the node is told when it is reachable again`,
  )
}

/**
 * `board nodes secret <id> <sink>` (#507, docs/design/nodes 10 item 3): a secret the owner gives one
 * of the device's sinks before anyone asks (git credentials, a key an MCP server reads). The fields
 * are the sink's own, from config.json's `nodes.devices.<id>.sinks`, which the bundle sends there;
 * each value is read from the terminal without echo, or a line each from stdin when it is a pipe,
 * never from an argument, never printed. The running board sends them to the node, which checks the
 * sink against its own copy and writes it; the line printed says where, never what.
 */
async function nodesSecret(webPort: number, id: string, sinkId: string, sinks: unknown): Promise<void> {
  const { fingerprintOf, givenFields, secretsConfig } = await import('../core/secrets.ts')
  const sink = secretsConfig({ sinks }, { home: homedir() }).sinks.get(sinkId)
  if (!sink) {
    const known = Object.keys(isRecord(sinks) ? sinks : {}).join(', ') || 'none'
    throw new Error(`${id} has no sink ${sinkId} in config.json (nodes.devices.${id}.sinks): ${known}`)
  }
  // The node checks the sink as it parses it there: a path this computer's platform would refuse
  // is the node's to judge, so only what the fields and the fingerprint are made of counts here.
  const check = givenFields({ ...sink, problems: [] })
  if (!check.ok) throw new Error(t(check.error, check.vars))
  const { readHidden, readStdin } = await import('../adapters/stdin.ts')
  const values: Record<string, string> = {}
  if (process.stdin.isTTY) {
    const typed = await readHidden(check.fields.map(f => `${f.name}: `))
    check.fields.forEach((f, i) => {
      values[f.name] = typed[i] ?? ''
    })
  } else {
    const lines = (await readStdin()).split(/\r?\n/)
    check.fields.forEach((f, i) => {
      values[f.name] = lines[i] ?? ''
    })
  }
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({
        op: 'secret',
        id,
        sink: sinkId,
        values,
        fingerprint: fingerprintOf(sink, {}, check.fields),
      }),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (err) {
    // No answer in time is not a board that does not run: the node may still have written it.
    if ((err as Error)?.name === 'TimeoutError')
      throw new Error(`no answer from the board in 90 s: \`board nodes\` says whether ${id} is reachable`)
    throw new Error(NO_BOARD)
  }
  const r: unknown = await res.json().catch(() => null)
  const a = isRecord(r) ? r : {}
  if (!res.ok || a.ok !== true)
    throw new Error(
      `not written · ${id} ${sinkId}: ${typeof a.error === 'string' ? a.error : `the board said ${res.status}`}`,
    )
  console.log(`ok · ${id} ${sinkId} written${typeof a.target === 'string' ? `: ${a.target}` : ''}`)
}

/**
 * `board nodes sync <id> [<profile>]` (#506): the running board makes the device current for the
 * profile (the default one unless given) and answers when the sync is over, 15 minutes at most
 * (bundle-sync.ts SYNC_TOTAL_MS; a first bundle is hundreds of files). Prints whether it is, then the
 * bundle's report lines that are not "sent": what was translated, what stays here and why, what the
 * node needs to be given; then the files the node kept as its own.
 */
async function nodesSync(webPort: number, id: string, profile: string | undefined): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'sync', id, ...(profile !== undefined && { profile }) }),
      // The board's own limit for a whole sync (15 minutes, SYNC_TOTAL_MS) and a minute over.
      signal: AbortSignal.timeout(16 * 60_000),
    })
  } catch {
    throw new Error(NO_BOARD)
  }
  const r: unknown = await res.json().catch(() => null)
  if (!res.ok || !isRecord(r))
    throw new Error(`the board said ${res.status}${isRecord(r) && r.error ? `: ${String(r.error)}` : ''}`)
  const lines: string[] = []
  const name = `${id} ${String(r.profile)}${r.nodeProfile !== r.profile ? ` (${String(r.nodeProfile)} there)` : ''}`
  lines.push(
    r.ok === true
      ? `ok · ${name} is current: bundle ${String(r.seq)}, ${String(r.sent)} file(s) sent${Array.isArray(r.applied) ? `, ${r.applied.length} changed` : ''}`
      : `not synced · ${name}: ${String(r.why)}${r.detail ? ` (${String(r.detail)})` : ''}`,
  )
  // The secrets (#604): which went, with the device's switch on; which are to be given by hand, off.
  const secrets = isRecord(r.secrets) ? r.secrets : null
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  const toGive = (Array.isArray(r.lines) ? r.lines.filter(isRecord) : [])
    .filter(e => e.verdict === 'needs-secret' && e.why !== 'reference')
    .map(e => String(e.name))
  if (secrets) {
    const given = [...names(secrets.given), ...names(secrets.files)]
    if (given.length) lines.push(`secrets given: ${given.join(', ')}`)
    if (secrets.error) lines.push(`secrets not given: the node said ${String(secrets.error)}`)
    const refused = names(secrets.refused)
    if (refused.length) lines.push(`secrets the node did not take: ${refused.join(', ')}`)
    // The GitHub login (#609): which host went, how the node took it, or why there was none to give.
    for (const l of Array.isArray(secrets.logins) ? secrets.logins.filter(isRecord) : [])
      lines.push(
        `GitHub login given: ${String(l.host)} (${String(l.user)})${l.via === 'store' ? ", in git's own store: pushes work, pull requests need gh there" : ''}`,
      )
    for (const k of Array.isArray(secrets.loginsKept) ? secrets.loginsKept.filter(isRecord) : [])
      lines.push(
        k.why === 'not-owned' || k.why === 'changed' || k.why === 'unreadable'
          ? `GitHub login not given: ${String(k.host)} has a login of the node's own`
          : k.why === 'older'
            ? `GitHub login not given: ${String(k.host)}, the node's board is older and takes none`
            : k.why === 'timeout' || k.why === 'failed-recently'
              ? `GitHub login not given: ${String(k.host)}, not tried this time (${String(k.why)})`
              : `GitHub login not given: ${String(k.host)} (${String(k.why)} failed on the node)`,
      )
    if (secrets.noLogin)
      lines.push(
        secrets.noLogin === 'no-gh'
          ? 'no GitHub login to give: gh is not on this computer'
          : 'no GitHub login to give: gh here is logged in to no host',
      )
    for (const k of Array.isArray(secrets.kept) ? secrets.kept.filter(isRecord) : [])
      lines.push(
        k.why === 'not-owned' || k.why === 'changed'
          ? `secret file left as it is on the node: ${String(k.path)} (${String(k.why)})`
          : `secret file not written on the node: ${String(k.path)} (${String(k.why)})`,
      )
  } else if (toGive.length) lines.push(`secrets to give by hand (this device is not given them): ${toGive.join(', ')}`)
  const went = new Set(secrets && !secrets.error ? [...names(secrets.given), ...names(secrets.files)] : [])
  for (const e of Array.isArray(r.lines) ? r.lines.filter(isRecord) : []) {
    // The owner's git identity (#609): it goes with every bundle, or this computer has none.
    if (e.kind === 'git') {
      lines.push(
        e.why === 'no-identity'
          ? "no git identity to give: this computer has no global user.name and user.email, and the node's commits carry its own"
          : identityLine(r.identity),
      )
      continue
    }
    // Of what went as it is, only what the owner should know: a program the node may lack, an answer given.
    if (e.verdict === 'sent' && e.why !== 'program-unchecked' && e.why !== 'acknowledged') continue
    // A secret the node was given is said above, not as one to give.
    if (e.verdict === 'needs-secret' && went.has(String(e.name))) continue
    // A reference is not always a secret: it may be the session's own environment.
    if (e.why === 'reference') {
      lines.push(
        `${String(e.kind)} ${String(e.detail)} refers to \${${String(e.name)}}: the node's sessions must have it, give it as a secret or in the env file${e.accepted ? ' · accepted' : ''}`,
      )
      continue
    }
    const detail = e.detail ? ` · ${String(e.detail)}` : ''
    lines.push(
      `${String(e.kind)} ${String(e.name)}: ${String(e.verdict)} (${String(e.why)})${detail}${e.accepted ? ' · accepted' : ''}`,
    )
  }
  for (const k of Array.isArray(r.kept) ? r.kept.filter(isRecord) : [])
    lines.push(`kept on the node: ${String(k.path)} (${String(k.why)})`)
  console.log(lines.join('\n'))
  if (r.ok !== true) process.exitCode = 1
}

/** What `board nodes sync` says of the identity that went (#609), by what the node did with it. */
function identityLine(done: unknown): string {
  if (done === 'set' || done === 'same') return 'git identity given'
  if (done === 'kept') return 'git identity not set on the node: its owner set another there, which stays'
  if (done === 'no-git') return 'git identity not set: the node has no git'
  if (done === 'failed') return 'git identity could not be set on the node: the next sync tries again'
  return 'git identity sent'
}

/** One device of GET /api/nodes as `board nodes` prints it. */
function deviceLine(d: Record<string, unknown>, masterId?: string): string {
  const defaultTitle =
    d.id === 'local' ? (typeof d.selfId === 'string' && d.selfId ? d.selfId : (masterId ?? 'local')) : String(d.id)
  const rawTitle = typeof d.title === 'string' ? d.title.trim() : ''
  const shownTitle = rawTitle && rawTitle.toLowerCase() !== 'local' ? rawTitle : ''
  const head = `${String(d.id)}${shownTitle && shownTitle !== d.id && shownTitle !== defaultTitle ? ` "${shownTitle}"` : ''}`
  const link = isRecord(d.link) ? d.link : null
  // A revoked device (#510): its link is gone once the node was told, or its credentials dropped.
  const revoked = isRecord(d.revoked) ? d.revoked : null
  if (revoked && !link)
    return `${head} · revoked · ${revoked.told === true ? 'the node was told' : 'not told, its token and key dropped'}`
  if (!link) return `${head} · this computer`
  if (revoked) return `${head} · revoked, not told yet · ${String(link.state)}`
  const parts = [`${head} · ${String(d.kind)} · ${String(link.state)}`]
  if (link.reason) parts.push(`(${String(link.reason)})`)
  const said = typeof link.detail === 'string' && link.detail ? `: ${link.detail}` : ''
  const since = typeof link.since === 'number' ? ` since ${clock(link.since)}` : ''
  const next = typeof link.nextAt === 'number' ? `, next try ${clock(link.nextAt, true)}` : ''
  const commit = d.sameCommit === false ? ' · another commit' : ''
  // How the node takes an update (#793), from a node that says it.
  const status = isRecord(d.status) ? d.status : null
  const updates =
    status?.updates === 'git' ? ' · updates by git' : status?.updates === 'archive' ? ' · updates from archive' : ''
  const held = typeof d.held === 'number' && d.held > 0 ? ` · ${d.held} held` : ''
  return `${parts.join(' ')}${since}${next}${commit}${updates}${held}${said}`
}
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
/**
 * `board time …` (#233, entrypoints/time-cli.ts): as the session that runs it, its lane the client
 * when none is named; outside a session, as the owner.
 */
async function timeCommand(): Promise<void> {
  const own: { key: string; name?: string | undefined; cwd?: string } | null = target
    ? await resolveSession()
    : await ownSession()
  const card = own ? readCard(own.key) : null
  const cwd = own && typeof own.cwd === 'string' && own.cwd ? own.cwd : process.cwd()
  const lane = (typeof card?.category === 'string' && card.category) || categoryFor(cfg, cwd)
  const name = own ? own.name || (target ? liveSessions().get(own.key)?.session.name : '') || '' : ''
  const { timeCmd } = await import('./time-cli.ts')
  // under --json an error is printed as JSON, and the exit code says it failed
  process.exitCode = await timeCmd(rest, { cfg, actor: own ? { key: own.key, name } : 'user', lane })
}

async function spendCommand(): Promise<void> {
  const { spendCmd } = await import('./spend-cli.ts')
  process.exitCode = await spendCmd(rest, { cfg, deps })
}

/** `board journal …` (#489, entrypoints/journal-cli.ts): what changed on the board since the owner left. */
async function journalCommand(): Promise<void> {
  if (nodeConfig(cfg.node)) {
    const caller = await nodeCaller()
    const { forwardNodeCall } = await import('./node-call.ts')
    const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
    process.exitCode = await forwardNodeCall({
      cmd: 'journal',
      argv: [...rest],
      session: caller?.key ?? null,
      port: cfg.port,
      json: flags.includes('--json'),
    })
    return
  }
  const { journalCmd } = await import('./journal-cli.ts')
  process.exitCode = journalCmd(rest, { cfg })
}

/** `board cal …` (#328, entrypoints/cal-cli.ts): the owner's calendar, changed as the session that runs it. */
async function calCommand(): Promise<void> {
  const isNode = nodeConfig(cfg.node) !== null
  const own = isNode && target ? await resolveSession().catch(() => null) : await ownSession()
  const lane =
    isNode && own
      ? (typeof readCard(own.key)?.category === 'string' && (readCard(own.key)?.category as string)) ||
        categoryFor(cfg, ('cwd' in own && typeof own.cwd === 'string' && own.cwd) || process.cwd()) ||
        null
      : null
  const { calCmd } = await import('./cal-cli.ts')
  process.exitCode = await calCmd(rest, {
    cfg,
    actor: own ? { key: own.key, name: own.name ?? '' } : 'user',
    ...(isNode && { lane }),
  })
}

/**
 * `board thread …` (#379, entrypoints/thread-cli.ts): written as the session that runs it, or the one
 * --session names (MokuPilot's day session), its lane the card's; outside a session, as the owner.
 */
async function threadCommand(): Promise<void> {
  const { threadCmd } = await import('./thread-cli.ts')
  process.exitCode = await threadCmd(rest, await threadContext())
}

/**
 * `board mcp` (#394, entrypoints/mcp.ts): the threads' two tools on stdio, each call `board thread`
 * as the session that started the server (or the one --session names), with config.json read again
 * for each call. With `--http` (#814): every tool of the board's /mcp, relayed (entrypoints/mcp-relay.ts).
 * With `--agents` (#628): exposes `ListAgents` and `SendMessage` instead, for
 * harnesses such as Antigravity CLI (`agy`) that have no built-in cross-session tools. Stdout
 * carries the protocol only.
 */
async function mcpCommand(): Promise<void> {
  const { createAgentsMcpServer, createMcpServer, serve } = await import('./mcp.ts')
  // `--http` (#814): a thin client of the board's /mcp, as this pane's session or --session's.
  if (flagWords.includes('--http')) {
    const { createHttpRelay, httpRelayHeaders } = await import('./mcp-relay.ts')
    const { boardMcpUrl } = await import('../core/mcp-register.ts')
    const relay = createHttpRelay({
      url: boardMcpUrl(loadConfig().port),
      headers: httpRelayHeaders(process.env, target),
    })
    await serve(relay, process.stdin, line => process.stdout.write(line))
    return
  }
  const { ROOT } = await import('../adapters/paths.ts')
  let version = ''
  try {
    version = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '')
  } catch {}
  if (flagWords.includes('--agents')) {
    const server = createAgentsMcpServer({
      version,
      listAgents: async () => {
        try {
          return await runAgents({ fresh: true, config: loadConfig() })
        } catch (e) {
          return { code: 1, out: [], err: [messageOf(e)] }
        }
      },
      sendMessage: async (to, message) => {
        try {
          return await runSend(to, message, { fresh: true, config: loadConfig() })
        } catch (e) {
          return { code: 1, out: [], err: [messageOf(e)] }
        }
      },
    })
    await serve(server, process.stdin, line => process.stdout.write(line))
    return
  }
  const { threadCmd } = await import('./thread-cli.ts')
  const server = createMcpServer({
    version,
    run: async argv => {
      const out: string[] = []
      const err: string[] = []
      try {
        const code = await threadCmd(argv, {
          ...(await threadContext(loadConfig())),
          idle: false,
          out: l => out.push(l),
          err: l => err.push(l),
        })
        return { code, out, err }
      } catch (e) {
        return { code: 1, out, err: [...err, messageOf(e)] }
      }
    },
  })
  await serve(server, process.stdin, line => process.stdout.write(line))
}

/** What `board thread` runs with: who writes (the session, --session's, or the owner), its lane, and how it finds sessions. */
async function threadContext(c: typeof cfg = cfg): Promise<ThreadCmdContext> {
  let s: { key: string; name?: string | undefined; cwd?: string } | null = target
    ? await resolveSession()
    : await ownSession()
  // The board's sessions, asked of herdr once, and only by what needs them.
  let board: ReturnType<typeof collect> | null = null
  const sessions = (): ReturnType<typeof collect> => {
    board ??= collect(deps)
    return board
  }
  // --session by the id of MokuPilot's running day session, which has no pane (#393): its card on
  // the board gives its name and folder, so its lane is the day's, not the folder MokuPilot runs the
  // command in. Any other session goes as before.
  const { threadsConfig } = await import('../core/work-threads.ts')
  if (s && target && UUID.test(target) && !s.cwd && threadsConfig(c.threads)) {
    const { runningDay } = await import('../adapters/mokupilot-day.ts')
    if (runningDay()?.session === s.key) {
      const item = (await sessions().catch(() => [])).find(i => i.key === s?.key && i.day)
      if (item) s = { key: item.key, name: item.name || s.name, cwd: item.cwd }
    }
  }
  const key = s?.key
  const name = s ? s.name || (target ? liveSessions().get(s.key)?.session.name : '') || s.key.slice(0, 8) : ''
  const card = key ? readCard(key) : null
  const cwd = s && typeof s.cwd === 'string' && s.cwd ? s.cwd : process.cwd()
  const lane = key ? (typeof card?.category === 'string' && card.category) || categoryFor(c, cwd) || null : null
  // Fetched at most once when `nodes` is on, never when `nodes` is off.
  let boardPayload: Promise<Record<string, unknown> | null> | null = null
  return {
    cfg: c,
    actor: key ? { kind: 'session', key, name } : { kind: 'owner' },
    lane,
    idle,
    // The session that runs it, for a verdict (#492): its own, never the one --session names; asked only then.
    // The pane herdr says it runs in must hold that session too: a session id put in the env does not pass.
    // It fails closed: no pane, no answer from herdr, or another session there is a refusal that says why.
    self: async () => {
      const { paneSelf } = await import('../services/work-verify.ts')
      const key = (target ? (await ownSession())?.key : s?.key) ?? null
      return paneSelf(key, process.env.HERDR_PANE_ID || undefined, async pane => {
        const p = await paneOf(pane)
        return p?.agent_session?.value ?? null
      })
    },
    findSession: async word => {
      const localFind = async () => {
        const w = word.toLowerCase()
        const items = (await sessions()).filter(i =>
          [i.name, i.autoName, i.pane, i.session, i.key].some(v => v && v.toLowerCase() === w),
        )
        if (items.length > 1)
          throw new Error(
            `"${word}" names ${items.length} sessions (${items.map(i => i.pane || i.key).join(', ')}): give its pane`,
          )
        const [item] = items
        if (item)
          return { kind: 'session' as const, key: item.key, name: item.name || item.autoName || item.key.slice(0, 8) }
        return UUID.test(word) || /^pane-\S+$/.test(word)
          ? { kind: 'session' as const, key: word, name: word.slice(0, 8) }
          : null
      }
      if (!c.nodes) return localFind()
      const { LOCAL, nodesConfig, parseNodeKey } = await import('../core/nodes.ts')
      const nodesCfg = nodesConfig(c.nodes, (await import('node:os')).hostname())
      if (!nodesCfg) return localFind()
      // Master with `nodes` (#693): resolve against the board aggregate (or local + offline node
      // snapshots when the web board is not running) using the same rules as `board send`, falling
      // back to paneless non-sleeping local cards that `--to` used to resolve before `nodes`.
      boardPayload ??= c.web === false ? Promise.resolve(null) : c === cfg ? boardAnswer() : fetchBoard(c.port)
      const body = await boardPayload
      const A = await import('../core/agent-send.ts')
      let own = ''
      let allItems: unknown[]
      if (body) {
        own = A.ownDeviceOf(body)
        allItems = Array.isArray(body.items) ? body.items : []
      } else {
        const { createDeviceStore } = await import('../adapters/node-store.ts')
        const { nodePart } = await import('../core/node-items.ts')
        const store = createDeviceStore()
        const remote = Object.entries(nodesCfg.devices).flatMap(([id, dev]) => {
          if (id === LOCAL || dev.revoked) return []
          const snap = store.snapshot(id)
          return snap ? (nodePart(snap.part, id)?.items ?? []) : []
        })
        own = nodesCfg.id
        allItems = [...(await sessions()), ...remote]
      }
      const hit =
        A.resolveTarget(A.targetsOf(allItems, own), word, own) ??
        A.resolveTarget(A.targetsOf(allItems, own, { includePaneless: true }), word, own)
      if (hit && 'error' in hit) {
        const { ThreadError } = await import('../adapters/work-thread-store.ts')
        throw new ThreadError('ambiguous', hit.error)
      }
      if (hit) return { kind: 'session', key: hit.target.key, name: hit.target.name }
      if (UUID.test(word) || /^pane-\S+$/.test(word)) return { kind: 'session', key: word, name: word.slice(0, 8) }
      const at = parseNodeKey(word)
      if (at && Object.hasOwn(nodesCfg.devices, at.device) && (UUID.test(at.key) || /^pane-\S+$/.test(at.key)))
        return { kind: 'session', key: word, name: at.key.slice(0, 8) }
      return null
    },
    sessionByKey: async word => {
      const item = (await sessions()).find(i => i.key === word || i.session === word)
      return item ? { kind: 'session', key: item.key, name: item.name || item.autoName || item.key.slice(0, 8) } : null
    },
    setAsk: async (question, decision) => {
      if (!key) return undefined
      // Decisions (#487): the question's options and default with it, while config.json turns them on.
      if (!decision || !decisionsConfig(c.decisions)) {
        writeCard(key, { ask: question, askSince: Date.now(), by: 'agent', decision: '' })
        return undefined
      }
      const { askThreadDecision } = await import('./decisions-cli.ts')
      return askThreadDecision({ key, name, lane }, question, decision, Date.now())
    },
    // On a node (#781): the decision its master holds for this question, on this session's card.
    setNodeAsk: (question, decision) => {
      if (key) writeCard(key, { ask: question, askSince: Date.now(), by: 'agent', decision: masterHeld(decision) })
    },
    // Case files (#488): where a case's sessions are now and their reminders, from the board's items
    // (asked of herdr once), the archive and the schedule; asked only by brief, and by show of a
    // thread that is a case (it has a reference or a state).
    ...(threadsConfig(c.threads)?.cases && {
      cases: (await import('../services/case-sessions.ts')).boardResolvers(sessions),
    }),
    reserveAsk: async spec => {
      if (!key || !decisionsConfig(c.decisions)) return undefined
      const { reserveThreadDecision } = await import('./decisions-cli.ts')
      return reserveThreadDecision({ key, name }, spec, Date.now())
    },
    releaseAsk: async reserved => (await import('./decisions-cli.ts')).releaseDecision(reserved),
    // --session names a session: whether it is the one running the command, asked only by what needs it.
    own: async () => !target || (await ownSession())?.key === key,
    decisions: decisionsConfig(c.decisions),
    openBoard: async key => {
      const { openWeb } = await import('../services/web-open.ts')
      const r = await openWeb(c, { thread: key })
      return r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error }
    },
    // An entry of a shared thread (#394): the running board sends it (as the session's post, or the
    // owner's behind the passkey); without a board it waits in the database and goes when one runs.
    sendOut: async (thread, entry) => {
      const webPort = Number(c.port) || 12422
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}/api/threads/${encodeURIComponent(thread)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ op: 'send', entry }),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.status === 428) return { out: 'confirm' }
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (body && typeof body.out === 'string') return body as unknown as { out: string }
        return res.status === 409 ? { out: 'queued', why: 'sharing is off on the board' } : null
      } catch {
        return null
      }
    },
  }
}

/** `board secret …` (#273, entrypoints/secret-cli.ts): the request goes on this session's card. */
async function secretCommand(): Promise<void> {
  const own = await ownSession()
  const { secretCmd } = await import('./secret-cli.ts')
  process.exitCode = await secretCmd(rest, {
    cfg,
    session: own ? { key: own.key, name: own.name ?? '' } : null,
    out: line => console.log(line),
  })
}

/** A flag's value: `--name value` in the command's words; undefined when it is not there. */
function option(name: string): string | undefined {
  const i = flagWords.indexOf(name)
  return i >= 0 ? flagWords[i + 1] : undefined
}

/** `board backup …` (#233): the backup of the board's database (services/backup.ts). */
async function backupCmd(): Promise<void> {
  // a node's database is the master's old one: its backups are the master's (#777)
  if (isNodeOnly(cfg)) throw new Error(await onNodeLine())
  const [op = 'status', arg] = words
  const backup = await import('../services/backup.ts')
  const { activeTargets, backupConfig, isTarget, problemSentence } = await import('../core/backup.ts')
  const c = backupConfig(cfg.backup)
  if (op === 'now') {
    const r = await backup.backupNow({ cfg, force: true })
    if (r.nothing) return console.log(t('backup.cli.nothing'))
    if (!r.sent.length && !r.failed.length) return console.log(t('backup.cli.noTargets'))
    for (const s of r.sent) console.log(t('backup.cli.sent', { target: s.target, name: s.name }))
    for (const f of r.failed) console.log(t('backup.cli.failed', { target: f.target, error: f.error }))
    if (r.failed.length) process.exitCode = 1
    return
  }
  if (op === 'status') {
    const v = backup.backupView(cfg)
    if (!v.needed) console.log(t('backup.cli.nothing'))
    for (const target of activeTargets(v.config)) {
      const s = v.states[target]
      const state = s?.lastOk ? t('backup.state.ok', { when: clock(s.lastOk) }) : t('backup.state.never')
      console.log(`${target} · ${state}${s?.error ? ` · ${t('backup.state.error', { error: s.error })}` : ''}`)
    }
    for (const p of v.problems) console.log(`! ${problemSentence(p, t)}`)
    if (v.problems.length) process.exitCode = 1
    return
  }
  if (op === 'list') {
    const targets = arg ? (isTarget(arg) ? [arg] : []) : activeTargets(c)
    if (!targets.length) throw new Error(arg ? t('backup.cli.usage') : t('backup.cli.noTargets'))
    for (const target of targets) {
      const list = await backup.listAt(target, c)
      console.log(t('backup.cli.list', { target, n: list.length }))
      for (const x of list) console.log(`  ${x.name}  ${Math.ceil(x.size / 1024)} KB`)
    }
    return
  }
  if (op === 'passphrase') {
    // never an argument (it would stay in the shell's history and the process list), never typed on a terminal here
    if (process.stdin.isTTY) throw new Error(t('backup.cli.usage'))
    const { readStdin } = await import('../adapters/stdin.ts')
    const [first = '', second = ''] = (await readStdin()).split(/\r?\n/)
    const r = await backup.setPassphrase(first, second)
    if (!r.ok) throw new Error(r.error)
    return console.log(t('backup.cli.passphraseSet'))
  }
  if (op === 'folder') {
    const { editBackup } = await import('../adapters/config-file.ts')
    if (arg === 'off') {
      const r = editBackup({ folder: null })
      if (!r.ok) throw new Error(r.error)
      backup.resetTarget('folder')
      return console.log(t('backup.cli.folderOff'))
    }
    if (!arg) throw new Error(t('backup.cli.usage'))
    const folder = resolve(arg)
    const { folderProblem } = await import('../adapters/backup-store.ts')
    const problem = folderProblem(folder)
    if (problem) throw new Error(t(problem, { folder }))
    const r = editBackup({ folder })
    if (!r.ok) throw new Error(r.error)
    backup.resetTarget('folder')
    return console.log(t('backup.cli.folderSet', { folder }))
  }
  if (op === 'test' && isTarget(arg)) {
    const r = await backup.testTarget(arg, cfg)
    if (!r.ok) throw new Error(r.error ?? '')
    return console.log(t('backup.tested', { name: r.name ?? '' }))
  }
  throw new Error(t('backup.cli.usage'))
}

/** What `board backup` and `board db` say on a node (#777): the machine that holds the database, by name. */
async function onNodeLine(): Promise<string> {
  let master: string | null = null
  try {
    const { createNodeStore } = await import('../adapters/node-store.ts')
    const { pickNodeMaster } = await import('../core/nodes.ts')
    const n = nodeConfig(cfg.node)
    if (n) master = pickNodeMaster(n.id, createNodeStore().list(), new Set())?.name || null
  } catch {}
  return master ? t('backup.cli.onNode', { master }) : t('backup.cli.onNodeUnnamed')
}

/** `board db restore …` (#233) and `board db rekey …` (#696). */
async function dbCmd(): Promise<void> {
  // restore and rekey write the database a node no longer serves (#777)
  if (isNodeOnly(cfg)) throw new Error(await onNodeLine())
  const [op] = words
  if (op === 'rekey') return dbRekeyCmd()
  if (op !== 'restore') throw new Error(t('backup.cli.restoreUsage'))
  const backup = await import('../services/backup.ts')
  const { activeTargets, backupConfig, isTarget } = await import('../core/backup.ts')
  const target = option('--target')
  const file = option('--file')
  const name = option('--snapshot')
  const passFile = option('--passphrase-file')
  if (target !== undefined && !isTarget(target)) throw new Error(t('backup.cli.restoreUsage'))
  if (!target && !file) {
    const c = backupConfig(cfg.backup)
    const targets = activeTargets(c)
    if (!targets.length) throw new Error(t('backup.cli.noTargets'))
    for (const tg of targets) {
      const list = await backup.listAt(tg, c)
      console.log(t('backup.cli.list', { target: tg, n: list.length }))
      for (const x of list.slice(-10)) console.log(`  ${x.name}  ${Math.ceil(x.size / 1024)} KB`)
    }
    return console.log(t('backup.cli.restoreUsage'))
  }
  const { passphraseFrom } = await import('../core/backup-file.ts')
  let passphrase: string | null = null
  if (passFile) passphrase = passphraseFrom(readFileSync(passFile))
  else if (flagWords.includes('--passphrase-stdin')) {
    // never typed on a terminal here (it would show): piped, as `board backup passphrase` takes it
    if (process.stdin.isTTY) throw new Error(t('backup.cli.restoreUsage'))
    const { readStdin } = await import('../adapters/stdin.ts')
    passphrase = passphraseFrom(Buffer.from(await readStdin()))
  }
  const webPort = Number(cfg.port) || 12422
  // what was newer and did not open: the hours it held are not in what was restored
  const passedOver = (skipped: readonly { name: string; why: string }[]) => {
    for (const x of skipped)
      console.log(t('backup.cli.skipped', { name: x.name, why: x.why.startsWith('backup.') ? t(x.why) : x.why }))
  }
  const r = await backup
    .restore({
      from: file ? { file: resolve(file) } : { target: target as 'folder' | 'server', ...(name && { name }) },
      cfg,
      passphrase,
      by: 'user',
      replaceFile: flagWords.includes('--replace-file'),
      boardRunning: async () => {
        try {
          await fetch(`http://127.0.0.1:${webPort}/api/hello`, { signal: AbortSignal.timeout(1500) })
          return true
        } catch {
          return false
        }
      },
    })
    .catch((err: unknown) => {
      // nothing taken: what it passed over is said before why
      if (err instanceof backup.BackupError) passedOver(err.skipped)
      throw err
    })
  passedOver(r.skipped)
  if (!r.inPlace) return console.log(t('backup.cli.restoredFile', { from: r.from, aside: r.aside ?? '' }))
  console.log(t('backup.cli.restored', { from: r.from, before: r.before ?? '-' }))
}

const DB_REKEY_USAGE = 'usage: board db rekey --from <old> --to <new> [--dry-run] [--json]'

/** `board db rekey --from <old> --to <new> [--dry-run] [--json]` (#696). */
async function dbRekeyCmd(): Promise<void> {
  const restArgs = flagWords.slice(1)
  if (words.length !== flagWords.length) throw new Error(DB_REKEY_USAGE)
  let from: string | undefined
  let to: string | undefined
  let dryRun = false
  let json = false
  for (let i = 0; i < restArgs.length; i++) {
    const w = restArgs[i] ?? ''
    if (w === '--dry-run') {
      dryRun = true
    } else if (w === '--json') {
      json = true
    } else if (w === '--from' || w.startsWith('--from=')) {
      if (from !== undefined) throw new Error(DB_REKEY_USAGE)
      const val = w === '--from' ? restArgs[++i] : w.slice('--from='.length)
      if (!val || val.startsWith('--')) throw new Error(DB_REKEY_USAGE)
      from = val
    } else if (w === '--to' || w.startsWith('--to=')) {
      if (to !== undefined) throw new Error(DB_REKEY_USAGE)
      const val = w === '--to' ? restArgs[++i] : w.slice('--to='.length)
      if (!val || val.startsWith('--')) throw new Error(DB_REKEY_USAGE)
      to = val
    } else {
      throw new Error(DB_REKEY_USAGE)
    }
  }
  const { formatRekeyReport, validateRekeyDevices } = await import('../core/db-rekey.ts')
  const checked = validateRekeyDevices(from, to)
  if (!checked.ok) throw new Error(`${checked.error}\n${DB_REKEY_USAGE}`)
  const { rekeyBoard } = await import('../services/db-rekey.ts')
  const report = rekeyBoard({ from: checked.from, to: checked.to, dryRun, by: 'user' })
  if (json) console.log(JSON.stringify(report, null, 2))
  else console.log(formatRekeyReport(report).join('\n'))
}

async function tunnel(): Promise<void> {
  const [op = 'status'] = words
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
  const ri = flagWords.indexOf('--report-id')
  const reportId = ri >= 0 ? flagWords[ri + 1] : null
  if (ri >= 0 && (!reportId || reportId.startsWith('--'))) throw new Error('missing report-id')
  if (reportId) reportIdentity(session, reportId)
  if (flagWords.includes('--status')) {
    if (!reportId) throw new Error('--status requires --report-id')
    const receipt = getReceipt(session, reportId)
    if (!receipt) throw new Error('no receipt for this session and report-id')
    return printReceipt(receipt)
  }
  const fi = flagWords.indexOf('--file')
  const file = fi >= 0 ? (flagWords[fi + 1] ?? '') : ''
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

/**
 * board update (#617): the board's update of itself now, through the running web board (POST
 * /api/self-update), whether or not the schedule is on. After an update that restarts the board it
 * waits for the new board to finish it (the record that names the new commit), 3.5 minutes at most.
 */
/**
 * `board update` on a node (#786): a node runs its master's commit, so the master ships it here
 * (Settings, Devices' Update; POST /api/nodes { op: 'update' } through the relay).
 */
async function updateFromMaster(): Promise<void> {
  const node = nodeConfig(cfg.node)
  if (!node) return selfUpdateNow()
  return nodesUpdate(Number(cfg.port) || 12422, node.id)
}

async function selfUpdateNow(): Promise<void> {
  if (cfg.web === false) throw new Error('board update goes through the web board, and config.json turns it off')
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/api/self-update`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Board': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'check' }),
    signal: AbortSignal.timeout(15 * 60_000),
  }).catch(() => null)
  if (!res) throw new Error('the web board does not answer, and board update goes through it (board doctor)')
  const body: unknown = await res.json().catch(() => null)
  if (!isRecord(body) || body.ok !== true || !isRecord(body.result))
    throw new Error(String((isRecord(body) && body.error) || `the web board answered ${res.status}`))
  const r = body.result
  const says = (view: unknown): string =>
    isRecord(view) && isRecord(view.standing) ? String(view.standing.text) : String(r.outcome)
  const came = (rec: Record<string, unknown>): void => {
    for (const title of Array.isArray(rec.came) ? rec.came : []) console.log(`  ${String(title)}`)
  }
  if (r.restarting !== true) {
    const bad = r.outcome === 'failed' || (r.outcome === 'skipped' && r.reason !== 'node')
    console.log(`${r.outcome === 'failed' ? 'failed' : 'ok'} · ${says(body.view)}`)
    if (r.outcome === 'updated') came(r)
    if (bad) process.exitCode = 1
    return
  }
  const short = (v: unknown): string => String(v ?? '').slice(0, 8)
  console.log(`ok · ${String(r.branch)} ${short(r.from)} -> ${short(r.to)}; the board and wake restart on it`)
  came(r)
  const end = Date.now() + 210_000
  while (Date.now() < end) {
    await new Promise(done => setTimeout(done, 3000))
    const view: unknown = await fetch(url, { signal: AbortSignal.timeout(5000) })
      .then(x => x.json())
      .catch(() => null)
    if (!isRecord(view) || !isRecord(view.state) || view.state.pending) continue
    const last = view.state.last
    if (!isRecord(last) || last.to !== r.to) continue
    console.log(`${last.outcome === 'updated' ? 'ok' : 'failed'} · ${says(view)}`)
    if (last.outcome !== 'updated') process.exitCode = 1
    return
  }
  console.log('failed · the board did not finish the update within 3.5 minutes (board doctor)')
  process.exitCode = 1
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
