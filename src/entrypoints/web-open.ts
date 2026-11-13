// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open (services/web-open.ts).
import { loadConfig } from '../adapters/config-file.ts'
import { openWeb, reminderClick, teamClick } from '../services/web-open.ts'

// `bun src/entrypoints/web-open.ts [--pane <herdr pane id>]`: exit code 3 when the board cannot
// show that session (not running, or no session there), for a caller that then goes to herdr.
// `--reminder <open | snooze | start> <id>`: a calendar reminder's button on the desktop (#335).
// `--team <thread key>`: a team message's notification clicked (#355).
// `--thread <key>`: a thread open in the threads panel (#392, `board thread open`).
if (import.meta.main) {
  const at = process.argv.indexOf('--pane')
  const pane = at > 0 ? process.argv[at + 1] : undefined
  const rem = process.argv.indexOf('--reminder')
  const team = process.argv.indexOf('--team')
  const thread = process.argv.indexOf('--thread')
  const r =
    rem > 0
      ? await reminderClick(process.argv[rem + 1] ?? '', process.argv[rem + 2] ?? '', loadConfig())
      : team > 0
        ? await teamClick(process.argv[team + 1] ?? '', loadConfig())
        : thread > 0
          ? await openWeb(loadConfig(), { thread: process.argv[thread + 1] ?? '' })
          : await openWeb(loadConfig(), { pane })
  console.log(r.ok ? `web board: ${r.url}${r.key ? ` (${r.key})` : ''}` : r.error)
  process.exitCode = r.ok ? 0 : r.missing ? 3 : 1
}
