// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open (services/web-open.ts).
import { loadConfig } from '../adapters/config-file.ts'
import { openWeb } from '../services/web-open.ts'

// `bun src/entrypoints/web-open.ts [--pane <herdr pane id>]`: exit code 3 when the board cannot
// show that session (not running, or no session there), for a caller that then goes to herdr.
if (import.meta.main) {
  const at = process.argv.indexOf('--pane')
  const pane = at > 0 ? process.argv[at + 1] : undefined
  const r = await openWeb(loadConfig(), { pane })
  console.log(r.ok ? `web board: ${r.url}${r.key ? ` (${r.key})` : ''}` : r.error)
  process.exitCode = r.ok ? 0 : r.missing ? 3 : 1
}
