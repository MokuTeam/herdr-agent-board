// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief (services/launch/spawn-agent.ts). The board starts new sessions with it when config.json
// sets no `launch.command`, and agents start other sessions with it (the board links the two by
// what it prints).
//
//   spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
//               [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
//               [--timeout-sec 120] [--session-id <uuid> | --resume <uuid>] [--pane <herdr pane id>]
//               [--profile <id>] [--model <id or alias>] [--agent claude|pi|agy|codex] [--trust]
//               [--effort <level>] [--approval on-request|never] [--sandbox <mode>]   (the last three: codex)
//   PowerShell-style names work too: -Name, -Cwd, -Label, -BriefFile, -Brief, -Workspace, -TimeoutSec.
//
// --resume brings back a session that ended (the board's archive): Claude resumes it by its id, in
// the folder it ran in, and it keeps the name it had, so no /rename is typed. An agent's resume
// runs in the profile whose folder holds its conversation.
//
// What it types into the tab is `launch.claude` in the board's config.json (default: claude),
// so a launcher of your own (one that sets up Telegram topics, say) goes there. A profile with a
// start command of its own (its `command` in config.json, an alias like cld-work) has that typed
// in place of `launch.claude`, its `args` after it. --pane starts Claude in that pane (at a shell
// prompt) instead of a new tab. --agent pi starts pi instead: `launch.pi` (default: pi) is typed,
// with no profile start command or arguments (those are Claude's), in the profile's env all the same.
//
// --agent codex starts Codex CLI: `launch.codex` (default: codex) typed into a new tab, a new
// session only (no --resume/--fork/--session-id, no Claude profile, no --trust). --model, --effort,
// --approval and --sandbox become Codex's own options; none given, Codex runs on its config.toml.
// config.json's `codexHome` (install.ts --codex-home) becomes CODEX_HOME of the tab.
//
// The session starts in the Claude profile of the agent that runs it (its CLAUDE_CONFIG_DIR), or
// in the one --profile names; the board's own starts pass --config-dir <folder> or --keep-env.
//
// --trust answers two startup dialogs with Yes instead of stopping there: the folder-trust dialog
// for --cwd itself, and "Allow external CLAUDE.md file imports?" when every file it lists is in
// the user's own Claude folders. Any other dialog still stops the start. A placed start (#798) takes it
// along: the board that runs it answers the folder-trust dialog for its folder.
//
// --model starts the session on that model: `--model <id>` after the start command and the
// profile's arguments (pi's own --model for pi), so the profile's default stays as it is; typing
// /model into the session would save it as the default of every later one in the profile.
//
// Prints "pane=<id> name=<Name> agent=<herdr name>", with " kind=pi" after it when the start
// command started pi or --agent codex started Codex; exits 1 with the reason when it fails. The board reads that line
// (services/launch/launcher.ts).
//
// With `nodes` in config.json (#505) a new session is the board's to place, when the board answers
// (services/launch/spawn-board.ts): it may start here (the same line), on a node ("pane=@<device>:…
// agent=@<device>:<session> device=<device> session=<id>"), or wait for room ("queued=<launch id>
// name=<Name> waiting=<device>:<kind>", exit 0). The spawn-agent the board's own launcher runs never
// asks it back.
//
// --device <id|local> (#760) pins a placed start to that machine (local: the board's own computer);
// a device the board does not list, one offline, or a board that cannot be asked fails at once. On a
// node (`node` without `nodes`) a new session is the master's to place (services/launch/spawn-node.ts):
// it goes up the node's uplink, and a master that cannot be asked or that does not place it leaves
// it to this computer, saying why, unless --device names another machine.
//
// --thread <key> (case files, #488, services/launch/case-start.ts) starts a fresh session from the
// case's brief, always on this computer, and gives it the thread; the line ends in " thread=<key>".
import { homedir } from 'node:os'
import { dedicatedCodexHome } from '../adapters/codex-home.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { cygpath, takeGitBashArgs } from '../adapters/git-bash.ts'
import { loadProfiles } from '../adapters/profiles.ts'
import { agyCommand, codexCommand, piCommand } from '../core/launch/agents.ts'
import {
  CASES_HELP,
  claudeCommand,
  HELP,
  LAUNCHER_CHILD,
  parseArgs,
  type SpawnOptions,
  spawnLine,
  withConvertedPaths,
} from '../core/launch/spawn-args.ts'
import type { SpawnParty } from '../core/spawn-limits.ts'
import type { Config } from '../core/types.ts'
import { paneInfo, spawnAgent } from '../services/launch/spawn-agent.ts'
import type { SpawnGate } from '../services/launch/spawn-gate.ts'

// Started by the sh shim under Git Bash (core/install-plan.ts GIT_BASH_PATHS, #490): the arguments
// came as typed, so a brief or a name that starts with / stays itself, and the folder and file
// options are converted here with Git's cygpath, as Git Bash would have. Neither variable goes on
// to herdr or what it starts (adapters/git-bash.ts).
const gitBash = takeGitBashArgs()
// The board's own launcher marks the spawn-agent it runs: that one starts here, whatever it was
// given, and nothing it starts inherits the mark.
const launcherChild = process.env[LAUNCHER_CHILD] !== undefined
delete process.env[LAUNCHER_CHILD]

/**
 * The profile's env file (#507) for the new tab, on a node or the master alike (#824): a board made
 * the master by a handover keeps its node's files. No file, no variables.
 */
async function nodeEnvOf(): Promise<Pick<Parameters<typeof spawnAgent>[1] & object, 'nodeEnv'>> {
  const { readNodeEnv } = await import('../adapters/node-env.ts')
  return { nodeEnv: profile => readNodeEnv(profile, msg => console.error(`spawn-agent: ${msg}`)) }
}

/**
 * Start the session here, in this computer's herdr. `kase` (#488, --thread): told once herdr reports
 * an agent in the new pane, and once the session is up, its words go after the spawn line. Returns
 * the line to print and the session it started.
 */
async function startHere(
  o: SpawnOptions,
  cfg: Config,
  kase?: { onAgent(pane: string): void; started(r: { session: string | null; name: string }): string },
): Promise<{ line: string; child: SpawnParty }> {
  const launch = cfg.launch ?? {}
  const register = o.workdeskWorker
    ? await (await import('../services/workdesk-workers.ts')).prepareWorkerLaunch(cfg.workdesk)
    : null
  const home = homedir()
  const r = await spawnAgent(o, {
    ...(o.agent === 'pi'
      ? { pi: piCommand(launch.pi) }
      : o.agent === 'agy'
        ? { agy: agyCommand(launch.agy) }
        : o.agent === 'codex'
          ? { codex: codexCommand(launch.codex), codexHome: dedicatedCodexHome() }
          : { claude: claudeCommand(launch.claude, launch.args) }),
    log: msg => console.error(`spawn-agent: ${msg}`),
    profiles: loadProfiles({ home }),
    env: process.env,
    home,
    ticketNames: launch.linkedWorkspaces === true,
    ...(await nodeEnvOf()),
    ...(kase && { onAgent: kase.onAgent }),
  })
  if (register) {
    try {
      register(r.kind, r.session)
    } catch (err) {
      // The worker is already running. Keep the normal success line and avoid a duplicate launch.
      console.error(
        `spawn-agent: Workdesk worker in ${r.pane} started, registration failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return {
    line: `${spawnLine(r)}${kase ? kase.started(r) : ''}`,
    child: { pane: r.pane, ...(r.session && { session: r.session }) },
  }
}

/**
 * The limits on a session's starts (#815, services/launch/spawn-gate.ts): null for the owner's
 * starts (no session in the env, the board's own launcher), which load none of it.
 */
async function gateOf(o: SpawnOptions, cfg: Config): Promise<SpawnGate | null> {
  if (launcherChild) return null
  const env = process.env
  if (!env.CLAUDE_CODE_SESSION_ID && !env.ANTIGRAVITY_CONVERSATION_ID && !env.CODEX_THREAD_ID && !env.HERDR_PANE_ID)
    return null
  const { gateSpawn } = await import('../services/launch/spawn-gate.ts')
  return gateSpawn(o, { env, cfg })
}

/** Start it: here, placed by the board, or up to a node's master; the line to print. */
async function start(o: SpawnOptions, cfg: Config): Promise<{ line: string; child?: SpawnParty }> {
  // Case files (#488): --thread starts here, never placed, from the case's brief.
  if (o.thread) return startCase(o, cfg)
  const hasNodes = cfg.nodes !== undefined && cfg.nodes !== null && cfg.nodes !== false
  const hasNode = cfg.node !== undefined && cfg.node !== null && cfg.node !== false
  // On a node (#760) the master places a new session; nothing of that is loaded elsewhere.
  const node = hasNode && !hasNodes && !launcherChild ? await nodeStart(o, cfg) : undefined
  if (node !== undefined) return node !== null ? { line: node } : startHere(o, cfg)
  // With `nodes` the board places a new session (#505); without it, nothing of that is loaded.
  const placed =
    hasNodes && !launcherChild
      ? await (await import('../services/launch/spawn-board.ts')).askBoard(o, cfg, {
          profiles: loadProfiles({ home: homedir() }),
          env: process.env,
          home: homedir(),
        })
      : null
  if (placed !== null) return { line: placed }
  // --device (#760) on a board with no other machine: only its own computer is one.
  if (o.device !== undefined && o.device !== 'local' && !hasNodes && !launcherChild)
    throw new Error(`--device ${o.device}: this board has no other devices (no nodes in its config.json)`)
  return startHere(o, cfg)
}

try {
  const parsed = parseArgs(process.argv.slice(2))
  const o = gitBash && !parsed.help ? withConvertedPaths(parsed, cygpath) : parsed
  if (o.help) {
    // Case files (#488): their option says it needs them on; the config is not read for the help.
    console.log(`${HELP}\n\n${CASES_HELP}`)
  } else {
    const cfg = loadConfig()
    // A session's start passes its limits first (#815), wherever it then runs.
    const gate = await gateOf(o, cfg)
    let started: { line: string; child?: SpawnParty }
    try {
      started = await start(o, cfg)
    } catch (err) {
      gate?.settle(null)
      throw err
    }
    console.log(started.line)
    gate?.settle(started.line, started.child)
  }
} catch (err) {
  console.error(`spawn-agent: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

/**
 * On a node (#760): the start the master made (its line), null to start it here, or undefined when
 * the master is not asked at all: not a node board after all, or a start the placer does not take.
 */
async function nodeStart(o: SpawnOptions, cfg: Config): Promise<string | null | undefined> {
  const [{ askMaster, boardHere, pureNode }, { placeable }] = await Promise.all([
    import('../services/launch/spawn-node.ts'),
    import('../core/launch/spawn-board.ts'),
  ])
  const node = await pureNode(cfg)
  if (!node || !placeable(o)) return undefined
  const [{ callBoard }, { herdrName }] = await Promise.all([
    import('./node-call.ts'),
    import('../services/launch/spawn-board.ts'),
  ])
  return askMaster(o, node, {
    profiles: loadProfiles({ home: homedir() }),
    env: process.env,
    home: homedir(),
    call: callBoard(cfg.port),
    board: boardHere(cfg.port),
    herdrName,
    log: line => console.error(`spawn-agent: ${line}`),
    ownLauncher: !!(cfg.launch?.command || cfg.launch?.agent),
  })
}

/**
 * --thread (#488): the case read, as the session that runs spawn-agent (else the owner), before
 * anything starts; then the session started on this computer, never placed on a node (its folder is
 * this computer's, and the assignment follows the start). From a node's session it is refused.
 * Once herdr reports an agent in the new pane (and, after a failure, still does) the session is the
 * assignee under the minted id, whether or not it finished starting; what is left to do is said on
 * stderr. No agent, and the case stays with its holder.
 */
async function startCase(o: SpawnOptions, cfg: Config): Promise<{ line: string; child: SpawnParty }> {
  if (cfg.node !== undefined && cfg.node !== null && cfg.node !== false) {
    const { nodeConfig } = await import('../core/nodes.ts')
    if (nodeConfig(cfg.node) !== null)
      throw new Error("--thread starts a session on the board's own computer: run it there, not from a node's session")
  }
  const [{ prepareCaseStart }, { boardResolvers }, { caseCaller }, { collect }, { defaultDeps }] = await Promise.all([
    import('../services/launch/case-start.ts'),
    import('../services/case-sessions.ts'),
    import('../services/launch/case-caller.ts'),
    import('../services/board.ts'),
    import('../services/deps.ts'),
  ])
  let items: ReturnType<typeof collect> | null = null
  const kase = await prepareCaseStart(o, {
    cfg,
    resolvers: boardResolvers(() => {
      items ??= collect(defaultDeps(cfg))
      return items
    }),
    actor: await caseCaller(),
  })
  for (const note of kase.notes) console.error(`spawn-agent: ${kase.key} ${note}`)
  let ran: string | null = null
  try {
    return await startHere(kase.options, cfg, {
      onAgent: pane => {
        ran = pane
      },
      started: r => {
        console.error(`spawn-agent: ${kase.assign(r.session, r.name)}`)
        return ` thread=${kase.key}`
      },
    })
  } catch (err) {
    // An agent herdr reported in the pane, and still reports when asked again here, runs under the
    // id it was given, ready or not (a dialog, a slow start, a brief that did not reach): it holds
    // the case, and the reason below says what is left to do. No agent seen, one gone since (a start
    // command that failed or exited at once), or its tab closed: no session holds anything, and the
    // case stays where it was.
    const message = err instanceof Error ? err.message : String(err)
    // Asked again now: an agent herdr named once may have exited since (a start that died at once).
    const still =
      ran !== null && !/was closed before/i.test(message)
        ? await paneInfo(ran, 10_000).then(
            p => !!p.agent,
            () => false,
          )
        : false
    if (still && ran !== null)
      console.error(
        `spawn-agent: ${kase.assign(null, kase.options.name)}; the session runs in ${ran} as ${kase.options.sessionId} but did not finish starting: what is left follows`,
      )
    else console.error(`spawn-agent: ${kase.key} stays with ${kase.heldBy}: no session came up to give it to`)
    throw err
  }
}
