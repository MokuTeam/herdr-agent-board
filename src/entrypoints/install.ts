// The "install" action: puts the `board` command on PATH (~/.local/bin, a sh script for Git Bash
// and a .cmd for PowerShell) and registers the SessionStart / UserPromptSubmit hooks in
// ~/.claude/settings.json. Idempotent; replaces its own earlier entries and keeps a backup of
// settings.json next to it. Run it again after moving the plugin or Bun: the hooks, the status
// line and the shims run the Bun that ran this (an absolute path, no PATH lookup).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultClaudeHome } from '../adapters/claude-home.ts'
import { ROOT } from '../adapters/paths.ts'
import { type InstallPaths, isOurCommand, planSettings, planShims } from '../core/install-plan.ts'

const settingsFile = join(defaultClaudeHome().root, 'settings.json')
const entrypoint = (name: string): string => join(ROOT, 'src', 'entrypoints', name)
const paths: InstallPaths = {
  bun: process.execPath,
  hook: entrypoint('hook.ts'),
  statusline: entrypoint('statusline.ts'),
  cli: entrypoint('cli.ts'),
  binDir: join(homedir(), '.local', 'bin'),
}

function installShims(): void {
  mkdirSync(paths.binDir, { recursive: true })
  for (const [name, body] of Object.entries(planShims(paths))) {
    const file = join(paths.binDir, name)
    if (existsSync(file) && !readFileSync(file, 'utf8').includes('agent-board')) {
      console.log(`skipped ${file}: exists and is not ours`)
      continue
    }
    writeFileSync(file, body, { mode: 0o755 })
  }
}

function installSettings(): void {
  const exists = existsSync(settingsFile)
  const { settings } = planSettings(exists ? JSON.parse(readFileSync(settingsFile, 'utf8')) : undefined, paths)
  if (exists) copyFileSync(settingsFile, `${settingsFile}.bak-agent-board`)
  const line = settings.statusLine
  const ours = !!line && typeof line === 'object' && 'command' in line && isOurCommand(String(line.command))
  console.log(ours ? `status line: ${paths.statusline}` : 'status line: left as it was (not ours)')
  mkdirSync(defaultClaudeHome().root, { recursive: true })
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
}

try {
  installShims()
  installSettings()
  console.log(`board command: ${join(paths.binDir, 'board')} (+ board.cmd)`)
  console.log(`hooks: SessionStart, UserPromptSubmit -> ${paths.hook} in ${settingsFile}`)
} catch (err) {
  console.error(`agent-board install: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
