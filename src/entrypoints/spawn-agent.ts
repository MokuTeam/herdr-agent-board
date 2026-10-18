// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief (services/launch/spawn-agent.ts). The board starts new sessions with it when config.json
// sets no `launch.command`, and agents start other sessions with it (the board links the two by
// what it prints).
//
//   spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
//               [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
//               [--timeout-sec 120] [--session-id <uuid>] [--pane <herdr pane id>] [--profile <id>]
//   PowerShell-style names work too: -Name, -Cwd, -Label, -BriefFile, -Brief, -Workspace, -TimeoutSec.
//
// What it types into the tab is `launch.claude` in the board's config.json (default: claude),
// so a launcher of your own (one that sets up Telegram topics, say) goes there. --pane starts
// Claude in that pane (at a shell prompt) instead of a new tab.
//
// The session starts in the Claude profile of the agent that runs it (its CLAUDE_CONFIG_DIR), or
// in the one --profile names; the board's own starts pass --config-dir <folder> or --keep-env.
//
// Prints "pane=<id> name=<Name> agent=<herdr name>"; exits 1 with the reason when it fails.
// The board reads that line (services/launch/launcher.ts).
import { homedir } from 'node:os'
import { loadConfig } from '../adapters/config-file.ts'
import { loadProfiles } from '../adapters/profiles.ts'
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
      claude: claudeCommand(launch.claude, launch.args),
      log: msg => console.error(`spawn-agent: ${msg}`),
      profiles: loadProfiles({ home }),
      env: process.env,
      home,
    })
    console.log(`pane=${r.pane} name=${r.name} agent=${r.agent}`)
  }
} catch (err) {
  console.error(`spawn-agent: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
