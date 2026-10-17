// The "install" action: puts the `board` and `spawn-agent` commands on PATH (~/.local/bin, a sh
// script for Git Bash, Linux and macOS and a .cmd for PowerShell), registers the SessionStart /
// UserPromptSubmit hooks and the status line in ~/.claude/settings.json, then says what else is
// set up and what is not (core/setup.ts). Idempotent; replaces its own earlier entries and keeps
// a backup of settings.json next to it. Run it again after moving or updating the plugin or Bun:
// the hooks, the status line and the shims run the Bun that ran this (an absolute path, no PATH
// lookup).
//
//   bun src/entrypoints/install.ts              the above; desktop notifications stay as they were
//   bun src/entrypoints/install.ts --toast      also Windows notifications with the agent's words
//                                               (the "notifications" action)
//   bun src/entrypoints/install.ts --no-toast   and without them
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultClaudeHome } from '../adapters/claude-home.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { ROOT } from '../adapters/paths.ts'
import { gatherFacts, herdrConfigFile, readText } from '../adapters/setup-facts.ts'
import { type InstallPaths, planSettings, planShims } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { boardFiles, checkSetup, report, tomlValue } from '../core/setup.ts'

const args = process.argv.slice(2)
for (const a of args.filter(a => a !== '--toast' && a !== '--no-toast'))
  console.log(`ignored ${a}: the options are --toast and --no-toast`)
let toast = args.includes('--toast') ? true : args.includes('--no-toast') ? false : undefined
if (toast && process.platform !== 'win32') {
  console.log(
    'desktop notifications: Windows only; on Linux and macOS herdr shows its own ([ui.toast] delivery = "system")',
  )
  toast = undefined
}

const claudeDir = defaultClaudeHome().root
const settingsFile = join(claudeDir, 'settings.json')
const paths: InstallPaths = { bun: process.execPath, ...boardFiles(ROOT), binDir: join(homedir(), '.local', 'bin') }
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function installShims(): void {
  mkdirSync(paths.binDir, { recursive: true })
  for (const [name, body] of Object.entries(planShims(paths))) {
    const file = join(paths.binDir, name)
    if (existsSync(file) && !readFileSync(file, 'utf8').includes('agent-board')) {
      console.log(`skipped ${file}: exists and is not ours`)
      continue
    }
    // A string is written as UTF-8 without a BOM, which the .cmd shims need (see planShims).
    writeFileSync(file, body, { mode: 0o755 })
  }
  console.log(`commands: board, spawn-agent in ${paths.binDir} (+ .cmd for PowerShell)`)
}

// A settings.json that does not parse, or is not an object, is left alone, and so is everything else.
const text = readText(settingsFile)
let before: unknown
try {
  if (text !== null) before = JSON.parse(text)
} catch {
  console.log(`${settingsFile} is not valid JSON: fix it, then run the install again. Nothing was changed.`)
  process.exit(1)
}

try {
  const plan = planSettings(before, paths, { toast })
  installShims()
  // --- hooks, status line, notifications
  if (text !== null) copyFileSync(settingsFile, `${settingsFile}.bak-agent-board`)
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(settingsFile, `${JSON.stringify(plan.settings, null, 2)}\n`)
  console.log(`hooks: SessionStart, UserPromptSubmit -> ${paths.hook} in ${settingsFile}`)
  console.log(plan.statusLineSet ? `status line: ${paths.statusline}` : 'status line: left as it was (not ours)')
  if (process.platform === 'win32') {
    console.log(
      plan.toast
        ? `desktop notifications: on (Stop, Notification, PreToolUse AskUserQuestion -> ${paths.toast})`
        : 'desktop notifications: off',
    )
    const delivery = tomlValue(readText(herdrConfigFile()), 'ui.toast', 'delivery') ?? 'off'
    if (plan.toast && delivery !== 'off')
      console.log(
        `  herdr shows its own too: set [ui.toast] delivery = "off" in ${herdrConfigFile()}, then herdr server reload-config`,
      )
  }
} catch (err) {
  console.error(`agent-board install: ${messageOf(err)}`)
  process.exit(1)
}

// --- what else is (not) set up
console.log('')
console.log(report(checkSetup(await gatherFacts(loadConfig(), { root: ROOT }), t), t))
