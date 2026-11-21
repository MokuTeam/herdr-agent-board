// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief (services/launch/spawn-agent.ts). The board starts new sessions with it when config.json
// sets no `launch.command`, and agents start other sessions with it (the board links the two by
// what it prints).
//
//   spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
//               [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
//               [--timeout-sec 120] [--session-id <uuid> | --resume <uuid>] [--pane <herdr pane id>]
//               [--profile <id>] [--model <id or alias>] [--agent claude|pi] [--trust]
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
// The session starts in the Claude profile of the agent that runs it (its CLAUDE_CONFIG_DIR), or
// in the one --profile names; the board's own starts pass --config-dir <folder> or --keep-env.
//
// --trust answers two startup dialogs with Yes instead of stopping there: the folder-trust dialog
// for --cwd itself, and "Allow external CLAUDE.md file imports?" when every file it lists is in
// the user's own Claude folders. Any other dialog still stops the start.
//
// --model starts the session on that model: `--model <id>` after the start command and the
// profile's arguments (pi's own --model for pi), so the profile's default stays as it is; typing
// /model into the session would save it as the default of every later one in the profile.
//
// Prints "pane=<id> name=<Name> agent=<herdr name>", with " kind=pi" after it when the start
// command started pi; exits 1 with the reason when it fails. The board reads that line
// (services/launch/launcher.ts).
//
// With `nodes` in config.json (#505) a new session is the board's to place, when the board answers
// (services/launch/spawn-board.ts): it may start here (the same line), on a node ("pane=@<device>:…
// agent=@<device>:<session> device=<device> session=<id>"), or wait for room ("queued=<launch id>
// name=<Name> waiting=<device>:<kind>", exit 0). The spawn-agent the board's own launcher runs never
// asks it back.
import { homedir } from 'node:os'
import { loadConfig } from '../adapters/config-file.ts'
import { cygpath, takeGitBashArgs } from '../adapters/git-bash.ts'
import { loadProfiles } from '../adapters/profiles.ts'
import { piCommand } from '../core/launch/agents.ts'
import {
  claudeCommand,
  HELP,
  LAUNCHER_CHILD,
  parseArgs,
  type SpawnOptions,
  spawnLine,
  withConvertedPaths,
} from '../core/launch/spawn-args.ts'
import type { Config } from '../core/types.ts'
import { spawnAgent } from '../services/launch/spawn-agent.ts'

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
 * On a node (#507), the profile's env file for the new tab. Without `node` in config.json nothing
 * of it is loaded or read.
 */
async function nodeEnvOf(cfg: Config): Promise<Pick<Parameters<typeof spawnAgent>[1] & object, 'nodeEnv'>> {
  if (cfg.node === undefined || cfg.node === null || cfg.node === false) return {}
  const { nodeConfig } = await import('../core/nodes.ts')
  if (nodeConfig(cfg.node) === null) return {}
  const { readNodeEnv } = await import('../adapters/node-env.ts')
  return { nodeEnv: profile => readNodeEnv(profile, msg => console.error(`spawn-agent: ${msg}`)) }
}

/** Start the session here, in this computer's herdr. */
async function startHere(o: SpawnOptions, cfg: Config): Promise<void> {
  const launch = cfg.launch ?? {}
  const register = o.workdeskWorker
    ? await (await import('../services/workdesk-workers.ts')).prepareWorkerLaunch(cfg.workdesk)
    : null
  const home = homedir()
  const r = await spawnAgent(o, {
    ...(o.agent === 'pi' ? { pi: piCommand(launch.pi) } : { claude: claudeCommand(launch.claude, launch.args) }),
    log: msg => console.error(`spawn-agent: ${msg}`),
    profiles: loadProfiles({ home }),
    env: process.env,
    home,
    ticketNames: launch.linkedWorkspaces === true,
    ...(await nodeEnvOf(cfg)),
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
  console.log(spawnLine(r))
}

try {
  const parsed = parseArgs(process.argv.slice(2))
  const o = gitBash && !parsed.help ? withConvertedPaths(parsed, cygpath) : parsed
  if (o.help) {
    console.log(HELP)
  } else {
    const cfg = loadConfig()
    // With `nodes` the board places a new session (#505); without it, nothing of that is loaded.
    const placed =
      cfg.nodes !== undefined && cfg.nodes !== null && cfg.nodes !== false && !launcherChild
        ? await (await import('../services/launch/spawn-board.ts')).askBoard(o, cfg, {
            profiles: loadProfiles({ home: homedir() }),
            env: process.env,
            home: homedir(),
          })
        : null
    if (placed !== null) console.log(placed)
    else await startHere(o, cfg)
  }
} catch (err) {
  console.error(`spawn-agent: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
