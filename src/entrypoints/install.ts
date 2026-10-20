// The "install" action: puts the `board` and `spawn-agent` commands on PATH (~/.local/bin, a sh
// script for Git Bash, Linux and macOS and a .cmd for PowerShell), copies the agents' skill
// (skills/herdr-agents) into the skills folder of every shown Claude profile and registers the
// SessionStart / UserPromptSubmit hooks and the status line in its settings.json (~/.claude, and
// each CLAUDE_CONFIG_DIR folder the board shows; a hidden one is left alone), has herdr put its
// own Claude hook there too (herdr integration install claude, from which herdr learns the session
// a pane runs), then says what else is set up and what is not (core/setup.ts). Idempotent;
// replaces its own earlier entries and keeps a backup of each settings.json next to it. A
// settings.json that does not parse stops it before anything is written. Run it again after
// moving or updating the plugin or Bun: the hooks, the status line and the shims run the Bun that
// ran this (an absolute path, no PATH lookup).
//
//   bun src/entrypoints/install.ts              the above; desktop notifications stay as they were
//   bun src/entrypoints/install.ts --toast      also Windows notifications with the agent's words
//                                               (the "notifications" action)
//   bun src/entrypoints/install.ts --no-toast   and without them
//   bun src/entrypoints/install.ts --codex      Codex's hooks and the commands, leaving Claude alone
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installSkill } from '../adapters/agents-skill.ts'
import { codexHooksPlan, installCodexHooks } from '../adapters/codex-hooks.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { claudeIntegrationInstall, codexIntegrationInstall } from '../adapters/herdr.ts'
import { installInto, readSettings } from '../adapters/hook-settings.ts'
import { ROOT } from '../adapters/paths.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { gatherFacts, herdrConfigFile, readText } from '../adapters/setup-facts.ts'
import { type InstallPaths, planSettings, planShims } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { DEFAULT_PROFILE, shownProfiles } from '../core/profiles.ts'
import { boardFiles, checkSetup, report, tomlValue } from '../core/setup.ts'

const args = process.argv.slice(2)
for (const a of args.filter(a => a !== '--toast' && a !== '--no-toast' && a !== '--codex'))
  console.log(`ignored ${a}: the options are --toast, --no-toast and --codex`)
let toast = args.includes('--toast') ? true : args.includes('--no-toast') ? false : undefined
if (toast && process.platform !== 'win32') {
  console.log(
    'desktop notifications: Windows only; on Linux and macOS herdr shows its own ([ui.toast] delivery = "system")',
  )
  toast = undefined
}

const files = boardFiles(ROOT)
const paths: InstallPaths = { bun: process.execPath, ...files, binDir: join(homedir(), '.local', 'bin') }
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
// Opt-in: the normal Claude install never reads or changes a Codex folder.
if (args.includes('--codex')) {
  try {
    if (args.includes('--toast') || args.includes('--no-toast'))
      throw new Error('--codex does not take --toast or --no-toast')
    const dir = process.env.CODEX_HOME || join(homedir(), '.codex')
    const script = join(ROOT, 'src', 'entrypoints', 'codex-hook.ts')
    const plan = codexHooksPlan(dir, script)
    installCodexHooks(plan)
    installShims()
    console.log(`Codex hooks: SessionStart, UserPromptSubmit -> ${script} in ${plan.file}`)
    if (Bun.which('bun') === null)
      console.log('Codex hooks: warning: bun is not on PATH; add Bun to PATH before starting Codex.')
    console.log(
      'Codex: enable hooks if disabled (codex features enable hooks), then review and trust these hooks in /hooks.',
    )
    try {
      await codexIntegrationInstall(dir)
      console.log(`herdr's hook: codex integration in ${dir}`)
    } catch (err) {
      console.log(
        `herdr's Codex hook: not installed: ${messageOf(err).split(/\r?\n/)[0]}. Run herdr integration install codex.`,
      )
    }
  } catch (err) {
    console.error(`agent-board install: ${messageOf(err)}`)
    process.exit(1)
  }
  process.exit(0)
}
// The shown profiles: config.json's with the folders found, the one this env points to shown too.
const profiles = shownProfiles(loadProfiles({ shownDir: inheritedProfileDir() }))

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

// Every profile's settings.json first: one that does not parse, or is not an object, stops the
// install before anything is written anywhere; that file and everything else stay as they were.
for (const profile of profiles) {
  const read = readSettings(profile.dir)
  if (read.error) {
    console.log(`${read.file} is not valid JSON: fix it, then run the install again. Nothing was changed.`)
    process.exit(1)
  }
  try {
    planSettings(read.text === null ? undefined : read.settings, paths, { toast })
  } catch (err) {
    console.error(`agent-board install: ${profiles.length > 1 ? `${read.file}: ` : ''}${messageOf(err)}`)
    process.exit(1)
  }
}

try {
  installShims()
  // --- the agents' skill (how sessions in herdr work with each other), read by Claude on demand
  const skillText = readText(files.skill)
  if (skillText === null) console.log(`skill: ${files.skill} is missing from this copy of the board`)
  // --- per profile: the skill, then hooks, status line, notifications; the default folder is made when it is not there
  let toastOn = false
  for (const profile of profiles) {
    const create = profile.id === DEFAULT_PROFILE
    if (!create && !isFolder(profile.dir)) {
      console.log(`skipped ${profile.dir}: the folder is not there`)
      continue
    }
    if (skillText !== null) {
      const skill = installSkill(profile.dir, skillText)
      console.log(
        skill.action === 'foreign'
          ? `skipped ${skill.file}: a skill of that name that is not ours`
          : `skill: ${skill.file}`,
      )
    }
    const out = installInto(profile.dir, paths, { toast, create })
    if (!out.ok) throw new Error(out.error)
    console.log(`hooks: SessionStart, UserPromptSubmit -> ${paths.hook} in ${out.file}`)
    console.log(
      out.statusLineSet ? `status line: ${paths.statusline}` : `status line in ${out.file}: left as it was (not ours)`,
    )
    if (process.platform === 'win32')
      console.log(
        out.toast
          ? `desktop notifications: on (Stop, Notification, PreToolUse AskUserQuestion -> ${paths.toast})`
          : 'desktop notifications: off',
      )
    toastOn ||= out.toast
    // herdr's own Claude hook, from which herdr learns the session a pane runs: herdr writes it.
    // A herdr that cannot (none on PATH, an older one) is said, and the install goes on.
    try {
      await claudeIntegrationInstall(profile.dir)
      console.log(`herdr's hook: claude integration in ${profile.dir}`)
    } catch (err) {
      console.log(`herdr's hook in ${profile.dir}: not installed: ${messageOf(err).split(/\r?\n/)[0]}`)
    }
  }
  if (process.platform === 'win32') {
    const delivery = tomlValue(readText(herdrConfigFile()), 'ui.toast', 'delivery') ?? 'off'
    if (toastOn && delivery !== 'off')
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
