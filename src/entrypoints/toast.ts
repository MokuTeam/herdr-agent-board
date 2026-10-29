// Claude Code's notification hook on macOS, and a click's way back: the counterpart of
// integrations/toast.ps1 (the install action registers both with --toast). Runs as an async hook,
// so herdr and the notification do not hold up Claude.
//
//   bun src/entrypoints/toast.ts                  Stop, Notification, PreToolUse (stdin)
//   bun src/entrypoints/toast.ts force            the same, also for the pane the user looks at
//   bun src/entrypoints/toast.ts click <pane id>  a notification was clicked
import { clickThrough, hookToast } from '../integrations/toast-mac.ts'

if (import.meta.main) {
  const [mode, pane] = process.argv.slice(2)
  if (mode === 'click') process.exitCode = await clickThrough(pane ?? '')
  else await hookToast({ force: mode === 'force' })
}
