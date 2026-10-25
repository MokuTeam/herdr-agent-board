// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief (services/launch/spawn-agent.ts). The board starts new sessions with it when config.json
// sets no `launch.command`, and agents start other sessions with it (the board links the two by
// what it prints).
//
//   spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
//               [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
//               [--timeout-sec 120] [--session-id <uuid> | --resume <uuid>] [--pane <herdr pane id>]
//               [--profile <id>] [--agent claude|pi]
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
// Prints "pane=<id> name=<Name> agent=<herdr name>", with " kind=pi" after it when the start
// command started pi; exits 1 with the reason when it fails. The board reads that line
// (services/launch/launcher.ts).
import { homedir } from 'node:os'
import { loadConfig } from '../adapters/config-file.ts'
import { loadProfiles } from '../adapters/profiles.ts'
import { piCommand } from '../core/launch/agents.ts'
import { claudeCommand, parseArgs, USAGE } from '../core/launch/spawn-args.ts'
import { spawnAgent } from '../services/launch/spawn-agent.ts'

try {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) {
    console.log(USAGE)
  } else {
    const launch = loadConfig().launch ?? {}
    const home = homedir()
    const r = await spawnAgent(o, {
      ...(o.agent === 'pi' ? { pi: piCommand(launch.pi) } : { claude: claudeCommand(launch.claude, launch.args) }),
      log: msg => console.error(`spawn-agent: ${msg}`),
      profiles: loadProfiles({ home }),
      env: process.env,
      home,
      ticketNames: launch.linkedWorkspaces === true,
    })
    console.log(`pane=${r.pane} name=${r.name} agent=${r.agent}${r.kind === 'claude' ? '' : ` kind=${r.kind}`}`)
  }
} catch (err) {
  console.error(`spawn-agent: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
