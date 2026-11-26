// The "install" action: puts the `board` and `spawn-agent` commands on PATH (~/.local/bin, a sh
// script for Git Bash, Linux and macOS and a .cmd for PowerShell), copies the agents' skill
// (skills/herdr-agents) and Team's (skills/agent-board-team, #369), and threads' while config.json
// turns them on (skills/agent-board-threads, #379), into the skills folder of
// every shown Claude profile and registers the
// SessionStart / UserPromptSubmit hooks, the PreToolUse hook on AskUserQuestion and the status
// line in its settings.json (~/.claude, and each CLAUDE_CONFIG_DIR folder the board shows; a
// hidden one is left alone), has herdr put its
// own Claude hook there too (herdr integration install claude, from which herdr learns the session
// a pane runs), and while wake is on adds wake's ListAgents / SendMessage hooks (never beside the
// separate herdr-wake plugin's), refreshes a claude-tg launcher of herdr-wake's to one that needs no
// Node (only where one is there), then says what else is set up and what is not (core/setup.ts).
// Idempotent; replaces its own earlier entries and keeps a backup of each settings.json next to it. A
// settings.json that does not parse stops it before anything is written. Run it again after
// moving or updating the plugin or Bun: the hooks, the status line and the shims run the Bun that
// ran this (an absolute path, no PATH lookup).
//
//   bun src/entrypoints/install.ts              the above; desktop notifications stay as they were
//   bun src/entrypoints/install.ts --toast      also desktop notifications with the agent's words
//                                               (the "notifications" action: Windows' PowerShell
//                                               script, macOS' toast.ts)
//   bun src/entrypoints/install.ts --no-toast   and without them
//   bun src/entrypoints/install.ts --codex      Codex's hooks and the commands, leaving Claude alone
//   bun src/entrypoints/install.ts --agy        Antigravity CLI's hooks, MCP, status line, skills and commands, leaving Claude alone
//   bun src/entrypoints/install.ts --codex --codex-home [dir] [--codex-master]
//                                               the same in a CODEX_HOME of its own for the sessions
//                                               herdr runs (default ~/.config/herdr/codex), linked to
//                                               ~/.codex for auth and config; ~/.codex is not written
//                                               but for the board's MCP table in config.toml, which
//                                               goes in through that link (#814)
//   bun src/entrypoints/install.ts --no-mcp     takes the board's MCP server out of every harness and
//                                               keeps it out (config.json "boardMcp": false)
//   bun src/entrypoints/install.ts --mcp        puts it back in (the default; #814)
//
// Every install (but --no-mcp) also registers the board's MCP server (#814, adapters/mcp-register.ts)
// in each shown profile's user scope and in Codex, agy and pi where they are the board's.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installSkill } from '../adapters/agents-skill.ts'
import {
  agyConfigDir,
  agyHooksPlan,
  agyMcpPlan,
  agySettingsDir,
  agySettingsPlan,
  installAgyHooks,
  installAgyMcp,
  installAgySettings,
} from '../adapters/agy-hooks.ts'
import { defaultCodexHome, prepareCodexHome } from '../adapters/codex-dedicated.ts'
import { dedicatedCodexHome } from '../adapters/codex-home.ts'
import { codexHooksPlan, installCodexHooks, labelHerdrHookIn } from '../adapters/codex-hooks.ts'
import { configFile, loadConfig, readConfigFile, withConfigFile } from '../adapters/config-file.ts'
import { agyIntegrationInstall, claudeIntegrationInstall, codexIntegrationInstall } from '../adapters/herdr.ts'
import { installInto, readSettings } from '../adapters/hook-settings.ts'
import { installLaunchers } from '../adapters/launchers.ts'
import { editCodexToml, registerBoardMcp, registeredLine } from '../adapters/mcp-register.ts'
import { ROOT } from '../adapters/paths.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { gatherFacts, herdrConfigFile, readText } from '../adapters/setup-facts.ts'
import { type InstallPaths, planSettings, planShims } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { boardMcpOff, boardMcpUrl } from '../core/mcp-register.ts'
import { DEFAULT_PROFILE, shownProfiles } from '../core/profiles.ts'
import { boardFiles, checkSetup, report, SKILL, TEAM_SKILL, THREADS_SKILL, tomlValue } from '../core/setup.ts'
import { wakeSwitch } from '../core/wake/config.ts'
import { threadsConfig } from '../core/work-threads.ts'
import { ensureToastApp, toastAppState } from '../integrations/toast-mac.ts'

const argv = process.argv.slice(2)
// --codex-home takes the folder that follows it unless that is another option.
const homeAt = argv.indexOf('--codex-home')
const homeValue = homeAt >= 0 && argv[homeAt + 1] && !argv[homeAt + 1]?.startsWith('--') ? argv[homeAt + 1] : undefined
const args = argv.filter((_, i) => i !== homeAt && !(homeValue !== undefined && i === homeAt + 1))
const master = args.includes('--codex-master')
for (const a of args.filter(
  a => !['--toast', '--no-toast', '--codex', '--codex-master', '--agy', '--mcp', '--no-mcp'].includes(a),
))
  console.log(
    `ignored ${a}: the options are --toast, --no-toast, --codex, --codex --codex-home [dir] [--codex-master], --agy, --mcp and --no-mcp`,
  )
let toast = args.includes('--toast') ? true : args.includes('--no-toast') ? false : undefined
const toasts = process.platform === 'win32' || process.platform === 'darwin'
if (toast && !toasts) {
  console.log(
    'desktop notifications: Windows and macOS only; on Linux herdr shows its own ([ui.toast] delivery = "system")',
  )
  toast = undefined
}

const files = boardFiles(ROOT)
const paths: InstallPaths & { wakeHook: string } = {
  bun: process.execPath,
  ...files,
  binDir: join(homedir(), '.local', 'bin'),
}
// Wake's hooks go in only while wake is on (#119), as config.json says now; read as the hooks read
// it, so a config.json that does not parse is off, and none is written when there is none.
const wake = wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
// The board's MCP server (#814): in every harness unless config.json says "boardMcp": false.
const mcpOn = (): boolean => !boardMcpOff(readConfigFile())
const mcpLines = (list: ReturnType<typeof registerBoardMcp>): void => {
  for (const r of list) if (r.action !== 'same') console.log(registeredLine(r))
}
// --mcp / --no-mcp: only the board's MCP server, in or out of every harness, and config.json to match.
if (args.includes('--mcp') || args.includes('--no-mcp')) {
  try {
    if (args.includes('--mcp') && args.includes('--no-mcp')) throw new Error('pass --mcp or --no-mcp, not both')
    if (args.some(a => a !== '--mcp' && a !== '--no-mcp'))
      throw new Error('--mcp and --no-mcp go alone: run the install without them for the rest')
    const on = args.includes('--mcp')
    loadConfig() // writes the defaults when there is no config.json yet
    withConfigFile((raw, save) => {
      if (!raw) return
      if (on && raw.boardMcp === false) {
        const { boardMcp: _, ...rest } = raw
        save(rest)
      } else if (!on && raw.boardMcp !== false) save({ ...raw, boardMcp: false })
    })
    const list = registerBoardMcp({
      on,
      port: loadConfig().port,
      bun: paths.bun,
      cli: paths.cli,
      profiles: shownProfiles(loadProfiles({ shownDir: inheritedProfileDir() })),
      codexHome: dedicatedCodexHome(),
    })
    mcpLines(list)
    if (list.every(r => r.action === 'same')) console.log(`board MCP: ${on ? 'in place' : 'not registered'} everywhere`)
    if (list.some(r => r.action === 'failed')) process.exit(1)
  } catch (err) {
    console.error(`agent-board install: ${messageOf(err)}`)
    process.exit(1)
  }
  process.exit(0)
}
// Opt-in: the normal Claude install never reads or changes an Antigravity CLI folder.
if (args.includes('--agy')) {
  try {
    if (args.includes('--toast') || args.includes('--no-toast'))
      throw new Error('--agy does not take --toast or --no-toast')
    if (args.includes('--codex')) throw new Error('pass --agy or --codex, not both')
    const dir = agyConfigDir()
    const settingsDir = agySettingsDir()
    const script = join(ROOT, 'src', 'entrypoints', 'agy-hook.ts')
    const agyStatusline = join(ROOT, 'src', 'entrypoints', 'agy-statusline.ts')
    const plan = agyHooksPlan(dir, script)
    const mcpPlan = agyMcpPlan(dir, paths.bun, paths.cli)
    const settingsPlan = agySettingsPlan(settingsDir, paths.bun, agyStatusline)
    installAgyHooks(plan)
    if (mcpOn()) installAgyMcp(mcpPlan)
    installAgySettings(settingsPlan)
    installShims()
    const agySkills = [
      { name: SKILL, from: files.skill },
      { name: TEAM_SKILL, from: files.teamSkill },
      ...(threadsConfig(loadConfig().threads) ? [{ name: THREADS_SKILL, from: files.threadsSkill }] : []),
    ].map(s => ({ ...s, text: readText(s.from) }))
    for (const s of agySkills) {
      if (s.text === null) continue
      const skill = installSkill(dir, s.text, s.name)
      console.log(
        skill.action === 'foreign'
          ? `skipped ${skill.file}: a skill of that name that is not ours`
          : `skill: ${skill.file}`,
      )
    }
    console.log(`Antigravity CLI hooks: SessionStart, PreInvocation -> ${script} in ${plan.file}`)
    if (mcpOn()) console.log(`Antigravity CLI MCP: the board's tools -> ${paths.cli} mcp --http in ${mcpPlan.file}`)
    console.log(
      settingsPlan.statusLineSet
        ? `Antigravity CLI status line: ${agyStatusline} in ${settingsPlan.file}`
        : `Antigravity CLI status line in ${settingsPlan.file}: left as it was (not ours)`,
    )
    if (Bun.which('bun') === null)
      console.log('Antigravity CLI hooks: warning: bun is not on PATH; add Bun to PATH before starting agy.')
    try {
      await agyIntegrationInstall()
      console.log(`herdr's hook: antigravity-cli integration in ${dir}`)
    } catch (err) {
      console.log(
        `herdr's Antigravity CLI hook: not installed: ${messageOf(err).split(/\r?\n/)[0]}. Run herdr integration install antigravity-cli.`,
      )
    }
  } catch (err) {
    console.error(`agent-board install: ${messageOf(err)}`)
    process.exit(1)
  }
  process.exit(0)
}
// Opt-in: the normal Claude install never reads or changes a Codex folder.
if (args.includes('--codex')) {
  try {
    if (args.includes('--toast') || args.includes('--no-toast'))
      throw new Error('--codex does not take --toast or --no-toast')
    if (homeAt >= 0 && (homeValue ?? '').startsWith('~'))
      throw new Error('--codex-home: write the folder out, the shell has not expanded ~')
    if (master && homeAt < 0) console.log('ignored --codex-master: it goes with --codex --codex-home')
    const dedicated = homeAt >= 0 ? (homeValue ?? defaultCodexHome()) : null
    const dir = dedicated ?? (process.env.CODEX_HOME || join(homedir(), '.codex'))
    const script = join(ROOT, 'src', 'entrypoints', 'codex-hook.ts')
    // Named in Codex's /hooks only in the dedicated home: a name changes a hook's trusted hash.
    const labels = dedicated
      ? { SessionStart: t('setup.codexHook.session'), UserPromptSubmit: t('setup.codexHook.prompt') }
      : undefined
    const plan = codexHooksPlan(dir, script, labels)
    if (dedicated) {
      const { linked, failed } = prepareCodexHome(dedicated, join(homedir(), '.codex'), { master })
      console.log(`Codex home: ${dedicated}${linked.length ? `, linked from ~/.codex: ${linked.join(', ')}` : ''}`)
      if (failed.length)
        console.log(`Codex home: could not link ${failed.join(', ')}; link or copy them into ${dedicated} yourself.`)
      // The board finds the rollouts of these sessions there (adapters/codex-home.ts).
      loadConfig() // writes the defaults when there is no config.json yet
      withConfigFile((raw, save) => {
        if (raw && raw.codexHome !== dedicated) save({ ...raw, codexHome: dedicated })
      })
      const skill = [
        { name: THREADS_SKILL, from: files.threadsSkill },
        { name: SKILL, from: files.codexSkill },
      ]
      for (const s of skill) {
        const text = readText(s.from)
        if (text !== null) console.log(`skill: ${installSkill(dedicated, text, s.name).file}`)
      }
    }
    installCodexHooks(plan)
    installShims()
    console.log(`Codex hooks: SessionStart, UserPromptSubmit -> ${script} in ${plan.file}`)
    if (mcpOn()) {
      const mcp = editCodexToml(join(dir, 'config.toml'), boardMcpUrl(loadConfig().port))
      if (mcp.action !== 'same') console.log(registeredLine(mcp))
    }
    if (Bun.which('bun') === null)
      console.log('Codex hooks: warning: bun is not on PATH; add Bun to PATH before starting Codex.')
    console.log(
      'Codex: enable hooks if disabled (codex features enable hooks), then review and trust these hooks in /hooks.',
    )
    if (dedicated)
      console.log(`Codex: the board's New session window and spawn-agent start Codex with CODEX_HOME=${dedicated}.`)
    try {
      await codexIntegrationInstall(dir)
      if (dedicated) labelHerdrHookIn(dir, t('setup.codexHook.herdr'))
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
    planSettings(read.text === null ? undefined : read.settings, paths, { toast, wake })
  } catch (err) {
    console.error(`agent-board install: ${profiles.length > 1 ? `${read.file}: ` : ''}${messageOf(err)}`)
    process.exit(1)
  }
}

/**
 * claude-tg (#119), while wake is on: a herdr-wake (or the board's) claude-tg already in the
 * commands' folder is replaced by the board's, which needs no Node; where there is none, none is
 * written (the panel's Install claude-tg does that), and someone else's is left alone. Said only
 * when one was written.
 */
function refreshLaunchers(): void {
  try {
    const { written } = installLaunchers(paths.binDir, { onlyWhereThere: true })
    if (written.length) console.log(`claude-tg: ${written.join(', ')} take the Telegram key from board tg-key now`)
  } catch (err) {
    console.log(`claude-tg: not refreshed: ${messageOf(err)}`)
  }
}

try {
  installShims()
  // claude-tg is wake's Telegram's: with wake off, a herdr-wake one stays as it was.
  if (wake) refreshLaunchers()
  // --- the skills Claude reads on demand: the agents' (how sessions in herdr work with each
  // other), then Team's (how they work with other people's boards, #369)
  const skills = [
    { name: SKILL, from: files.skill },
    { name: TEAM_SKILL, from: files.teamSkill },
    // threads' (#379), only while config.json turns them on
    ...(threadsConfig(loadConfig().threads) ? [{ name: THREADS_SKILL, from: files.threadsSkill }] : []),
  ].map(s => ({ ...s, text: readText(s.from) }))
  for (const s of skills) if (s.text === null) console.log(`skill: ${s.from} is missing from this copy of the board`)
  // --- per profile: the skill, then hooks, status line, notifications; the default folder is made when it is not there
  let toastOn = false
  for (const profile of profiles) {
    const create = profile.id === DEFAULT_PROFILE
    if (!create && !isFolder(profile.dir)) {
      console.log(`skipped ${profile.dir}: the folder is not there`)
      continue
    }
    for (const s of skills) {
      if (s.text === null) continue
      const skill = installSkill(profile.dir, s.text, s.name)
      console.log(
        skill.action === 'foreign'
          ? `skipped ${skill.file}: a skill of that name that is not ours`
          : `skill: ${skill.file}`,
      )
    }
    const out = installInto(profile.dir, paths, { toast, create, wake })
    if (!out.ok) throw new Error(out.error)
    console.log(`hooks: SessionStart, UserPromptSubmit, PreToolUse (AskUserQuestion) -> ${paths.hook} in ${out.file}`)
    console.log(
      out.statusLineSet ? `status line: ${paths.statusline}` : `status line in ${out.file}: left as it was (not ours)`,
    )
    if (toasts)
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
    // Wake's hooks: said only while wake is on; never beside the separate herdr-wake plugin's.
    if (out.wakeHooks === 'added')
      console.log(`wake hooks: ListAgents, SendMessage -> ${paths.wakeHook} in ${out.file}`)
    else if (out.wakeHooks === 'old')
      console.log(
        "wake hooks: not added: the separate herdr-wake plugin's are there (Settings → Sleep and wake… → Switch over…)",
      )
  }
  // The board's MCP server (#814): each shown profile's user scope, and Codex, agy and pi where they are the board's.
  if (mcpOn())
    mcpLines(
      registerBoardMcp({
        on: true,
        port: loadConfig().port,
        bun: paths.bun,
        cli: paths.cli,
        profiles,
        codexHome: dedicatedCodexHome(),
      }),
    )
  if (toasts) {
    const delivery = tomlValue(readText(herdrConfigFile()), 'ui.toast', 'delivery') ?? 'off'
    if (toastOn && delivery !== 'off')
      console.log(
        `  herdr shows its own too: set [ui.toast] delivery = "off" in ${herdrConfigFile()}, then herdr server reload-config`,
      )
  }
  // macOS: the notification app (macOS shows notifications only for an app LaunchServices knows).
  // Built here so the first notification comes at once; a click on it opens the session's sheet.
  // An app that is there and current is kept; one that failed to build is tried again (a hook does not).
  if (process.platform === 'darwin' && toastOn) {
    const app = ensureToastApp({ retry: true })
    if (app) {
      console.log(`desktop notifications: the app that shows them: ${app}`)
      console.log('  the first one asks to allow "Claude": allow it, or turn it on in System Settings > Notifications')
    } else {
      console.log(
        `desktop notifications: the app that shows them was not built (${toastAppState().failed ?? 'it could not be built'}); until it is, the hook shows herdr's own notification`,
      )
      console.log(
        '  to build it, install the Command Line Tools if they are missing (xcode-select --install), then run the install with --toast again',
      )
    }
  }
} catch (err) {
  console.error(`agent-board install: ${messageOf(err)}`)
  process.exit(1)
}

// --- what else is (not) set up
console.log('')
console.log(report(checkSetup(await gatherFacts(loadConfig(), { root: ROOT }), t), t))
